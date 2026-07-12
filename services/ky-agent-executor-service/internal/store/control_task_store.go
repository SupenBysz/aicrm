package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

const (
	TaskEventChanged  = "executor.task.changed"
	TaskEventTerminal = "executor.task.terminal"
	TaskEventClosed   = "executor.task.stream.closed"

	TaskTerminalANSIFrame = "executor.task.ansi-frame"
	TaskTerminalTerminal  = "executor.task.terminal"
	TaskTerminalClosed    = "executor.task.stream-closed"
)

var ErrUnsafeProjection = errors.New("unsafe task projection")

type PublicTaskProjection struct {
	ID                        string  `json:"id"`
	WorkspaceType             string  `json:"workspaceType"`
	WorkspaceID               string  `json:"workspaceId"`
	ExecutorID                string  `json:"executorId"`
	ExecutorType              string  `json:"executorType"`
	TaskType                  string  `json:"taskType"`
	ScriptPurpose             string  `json:"scriptPurpose"`
	Status                    string  `json:"status"`
	WebSpaceID                string  `json:"webSpaceId"`
	ScriptID                  string  `json:"scriptId"`
	ScriptVersionID           string  `json:"scriptVersionId"`
	ContractID                string  `json:"contractId"`
	ContractRevision          *int64  `json:"contractRevision"`
	EffectiveModelKey         string  `json:"effectiveModelKey"`
	ExecutorConfigRevision    *int64  `json:"executorConfigRevision"`
	CredentialBindingRevision *int64  `json:"credentialBindingRevision"`
	RuntimeBindingRevision    *int64  `json:"runtimeBindingRevision"`
	ModelCatalogRevision      *int64  `json:"modelCatalogRevision"`
	GenerationEngine          string  `json:"generationEngine"`
	Revision                  int64   `json:"revision"`
	CurrentSequence           int64   `json:"currentSequence"`
	FailureCode               string  `json:"failureCode"`
	StartedAt                 *string `json:"startedAt"`
	CompletedAt               *string `json:"completedAt"`
	CreatedAt                 string  `json:"createdAt"`
	UpdatedAt                 string  `json:"updatedAt"`
}

type PublicTaskFilter struct {
	WorkspaceType string
	WorkspaceID   string
	Status        string
	TaskType      string
	ExecutorID    string
	Page          int
	PageSize      int
}

type PublicTaskEventProjection struct {
	ID         string          `json:"id"`
	TaskID     string          `json:"taskId"`
	Sequence   int64           `json:"sequence"`
	EventType  string          `json:"eventType"`
	Level      string          `json:"level"`
	Message    string          `json:"message"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt string          `json:"occurredAt"`
}

type PublicTaskTerminalProjection struct {
	Sequence   int64  `json:"sequence"`
	Kind       string `json:"kind"`
	Encoding   string `json:"encoding,omitempty"`
	Payload    string `json:"payload,omitempty"`
	ByteLength int    `json:"byteLength,omitempty"`
	Status     string `json:"status,omitempty"`
	Reason     string `json:"reason,omitempty"`
	CreatedAt  string `json:"createdAt"`
}

type CancelPublicTaskInput struct {
	TaskID             string
	ActorID            string
	WorkspaceType      string
	WorkspaceID        string
	ExpectedRevision   int64
	IdempotencyKeyHash string
	RequestHash        string
}

const publicTaskSelect = `
	SELECT task.id, task.workspace_type, task.workspace_id,
	       COALESCE(NULLIF(task.effective_executor_id,''), task.executor_id),
	       task.executor_type, task.task_type, task.purpose, task.status,
	       task.web_space_id, task.script_id, task.script_version_id,
	       task.contract_id, task.contract_revision, task.effective_model_key,
	       task.executor_config_revision, task.credential_binding_revision,
	       task.runtime_binding_revision, task.model_catalog_revision,
	       task.generation_engine, task.revision, task.current_sequence,
	       task.failure_code, task.started_at, task.completed_at,
	       task.created_at, task.updated_at
	FROM ky_ai_executor_task task
`

func scanPublicTask(row rowScanner) (PublicTaskProjection, error) {
	var item PublicTaskProjection
	var contractRevision, executorRevision, credentialRevision sql.NullInt64
	var runtimeRevision, catalogRevision sql.NullInt64
	var startedAt, completedAt sql.NullTime
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.ExecutorID,
		&item.ExecutorType, &item.TaskType, &item.ScriptPurpose, &item.Status,
		&item.WebSpaceID, &item.ScriptID, &item.ScriptVersionID,
		&item.ContractID, &contractRevision, &item.EffectiveModelKey,
		&executorRevision, &credentialRevision, &runtimeRevision, &catalogRevision,
		&item.GenerationEngine, &item.Revision, &item.CurrentSequence,
		&item.FailureCode, &startedAt, &completedAt, &createdAt, &updatedAt,
	)
	if err != nil {
		return PublicTaskProjection{}, err
	}
	item.ContractRevision = nullableInt64(contractRevision)
	item.ExecutorConfigRevision = nullableInt64(executorRevision)
	item.CredentialBindingRevision = nullableInt64(credentialRevision)
	item.RuntimeBindingRevision = nullableInt64(runtimeRevision)
	item.ModelCatalogRevision = nullableInt64(catalogRevision)
	item.FailureCode = safeStoredCode(item.FailureCode)
	item.StartedAt = nullableTime(startedAt)
	item.CompletedAt = nullableTime(completedAt)
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return item, nil
}

func (s *ControlStore) ListPublicTasks(ctx context.Context, filter PublicTaskFilter) ([]PublicTaskProjection, int64, error) {
	where := ` WHERE task.workspace_type=$1 AND task.workspace_id=$2`
	args := []any{filter.WorkspaceType, filter.WorkspaceID}
	add := func(column, value string) {
		if value == "" {
			return
		}
		args = append(args, value)
		where += fmt.Sprintf(" AND %s=$%d", column, len(args))
	}
	add("task.status", filter.Status)
	add("task.task_type", filter.TaskType)
	if filter.ExecutorID != "" {
		args = append(args, filter.ExecutorID)
		where += fmt.Sprintf(" AND COALESCE(NULLIF(task.effective_executor_id,''), task.executor_id)=$%d", len(args))
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_task task`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	offset := (filter.Page - 1) * filter.PageSize
	args = append(args, filter.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, publicTaskSelect+where+
		fmt.Sprintf(" ORDER BY task.created_at DESC, task.id LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]PublicTaskProjection, 0, filter.PageSize)
	for rows.Next() {
		item, err := scanPublicTask(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

func (s *ControlStore) GetPublicTask(ctx context.Context, id, workspaceType, workspaceID string) (PublicTaskProjection, error) {
	item, err := scanPublicTask(s.db.QueryRowContext(ctx, publicTaskSelect+`
		WHERE task.id=$1 AND task.workspace_type=$2 AND task.workspace_id=$3
	`, id, workspaceType, workspaceID))
	if errors.Is(err, sql.ErrNoRows) {
		return PublicTaskProjection{}, ErrNotFound
	}
	return item, err
}

func (s *ControlStore) ListPublicTaskEvents(ctx context.Context, taskID, workspaceType, workspaceID string, after int64, limit int) ([]PublicTaskEventProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT event.id, event.task_id, event.sequence, event.event_type,
		       event.level, event.safe_payload_json, event.created_at
		FROM ky_ai_executor_task_event event
		JOIN ky_ai_executor_task task ON task.id=event.task_id
		WHERE event.task_id=$1 AND task.workspace_type=$2 AND task.workspace_id=$3
		  AND event.sequence>$4
		ORDER BY event.sequence LIMIT $5
	`, taskID, workspaceType, workspaceID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PublicTaskEventProjection, 0, limit)
	for rows.Next() {
		var item PublicTaskEventProjection
		var payload []byte
		var occurredAt time.Time
		if err := rows.Scan(&item.ID, &item.TaskID, &item.Sequence, &item.EventType,
			&item.Level, &payload, &occurredAt); err != nil {
			return nil, err
		}
		if !json.Valid(payload) {
			return nil, ErrUnsafeProjection
		}
		item.Message = publicTaskEventMessage(item.EventType)
		item.Payload = append(json.RawMessage(nil), payload...)
		item.OccurredAt = occurredAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func publicTaskEventMessage(eventType string) string {
	switch eventType {
	case TaskEventChanged:
		return "Task state changed"
	case TaskEventTerminal:
		return "Task reached a terminal state"
	case TaskEventClosed:
		return "Task event stream closed"
	default:
		return "Task event"
	}
}

func (s *ControlStore) ListPublicTaskTerminal(ctx context.Context, taskID, workspaceType, workspaceID string, after int64, limit int) ([]PublicTaskTerminalProjection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT raw.sequence, raw.raw_json, raw.created_at
		FROM ky_ai_executor_task_raw_log raw
		JOIN ky_ai_executor_task task ON task.id=raw.task_id
		WHERE raw.task_id=$1 AND task.workspace_type=$2 AND task.workspace_id=$3
		  AND raw.sequence>$4 AND raw.source='executor' AND raw.direction='internal'
		  AND raw.raw_json->>'projectionKind' IN ('ansi_frame','terminal','closed')
		ORDER BY raw.sequence LIMIT $5
	`, taskID, workspaceType, workspaceID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PublicTaskTerminalProjection, 0, limit)
	for rows.Next() {
		var sequence int64
		var raw []byte
		var createdAt time.Time
		if err := rows.Scan(&sequence, &raw, &createdAt); err != nil {
			return nil, err
		}
		item, err := decodeTerminalProjection(sequence, raw, createdAt)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *ControlStore) PublicTaskTerminalClosedSequence(ctx context.Context, taskID, workspaceType, workspaceID string) (int64, error) {
	var sequence sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT MAX(raw.sequence)
		FROM ky_ai_executor_task_raw_log raw
		JOIN ky_ai_executor_task task ON task.id=raw.task_id
		WHERE raw.task_id=$1 AND task.workspace_type=$2 AND task.workspace_id=$3
		  AND raw.source='executor' AND raw.direction='internal'
		  AND raw.raw_json->>'projectionKind'='closed'
		  AND raw.raw_json->>'reason'='terminal'
	`, taskID, workspaceType, workspaceID).Scan(&sequence)
	if err != nil {
		return 0, err
	}
	if !sequence.Valid {
		return 0, nil
	}
	return sequence.Int64, nil
}

func decodeTerminalProjection(sequence int64, raw []byte, createdAt time.Time) (PublicTaskTerminalProjection, error) {
	var value struct {
		ProjectionKind string `json:"projectionKind"`
		Encoding       string `json:"encoding"`
		Payload        string `json:"payload"`
		ByteLength     int    `json:"byteLength"`
		Status         string `json:"status"`
		Reason         string `json:"reason"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return PublicTaskTerminalProjection{}, ErrUnsafeProjection
	}
	item := PublicTaskTerminalProjection{Sequence: sequence, CreatedAt: createdAt.UTC().Format(time.RFC3339Nano)}
	switch value.ProjectionKind {
	case "ansi_frame":
		decoded, err := base64.StdEncoding.DecodeString(value.Payload)
		if err != nil || value.Encoding != "base64" || value.ByteLength != len(decoded) || len(decoded) > 64<<10 {
			return PublicTaskTerminalProjection{}, ErrUnsafeProjection
		}
		item.Kind, item.Encoding, item.Payload, item.ByteLength = "frame", value.Encoding, value.Payload, value.ByteLength
	case "terminal":
		if !terminalTaskStatus(value.Status) {
			return PublicTaskTerminalProjection{}, ErrUnsafeProjection
		}
		item.Kind, item.Status = "terminal", value.Status
	case "closed":
		if value.Reason != "terminal" {
			return PublicTaskTerminalProjection{}, ErrUnsafeProjection
		}
		item.Kind, item.Reason = "closed", value.Reason
	default:
		return PublicTaskTerminalProjection{}, ErrUnsafeProjection
	}
	return item, nil
}

func (s *ControlStore) CancelPublicTask(ctx context.Context, input CancelPublicTaskInput) (PublicTaskProjection, bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return PublicTaskProjection{}, false, err
	}
	defer tx.Rollback()
	var existingHash, existingTaskID string
	err = tx.QueryRowContext(ctx, `
		SELECT request_hash,resource_id FROM ky_ai_executor_api_idempotency
		WHERE actor_id=$1 AND action='cancel_task' AND scope_id=$2 AND idempotency_key_hash=$3
	`, input.ActorID, input.TaskID, input.IdempotencyKeyHash).Scan(&existingHash, &existingTaskID)
	if err == nil {
		if existingHash != input.RequestHash || existingTaskID != input.TaskID {
			return PublicTaskProjection{}, false, ErrIdempotencyReuse
		}
		item, err := scanPublicTask(tx.QueryRowContext(ctx, publicTaskSelect+`
			WHERE task.id=$1 AND task.workspace_type=$2 AND task.workspace_id=$3
		`, input.TaskID, input.WorkspaceType, input.WorkspaceID))
		return item, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PublicTaskProjection{}, false, err
	}

	var operationID, executorID string
	var leaseEpoch, sourceRevision, revocationEpoch, sequence, revision int64
	var status string
	err = tx.QueryRowContext(ctx, `
		SELECT status,revision,current_sequence,operation_id,lease_epoch,
		       source_credential_revision,revocation_epoch,
		       COALESCE(NULLIF(effective_executor_id,''),executor_id)
		FROM ky_ai_executor_task
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 FOR UPDATE
	`, input.TaskID, input.WorkspaceType, input.WorkspaceID).Scan(
		&status, &revision, &sequence, &operationID, &leaseEpoch,
		&sourceRevision, &revocationEpoch, &executorID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicTaskProjection{}, false, ErrNotFound
	}
	if err != nil {
		return PublicTaskProjection{}, false, err
	}
	if !terminalTaskStatus(status) && revision != input.ExpectedRevision {
		return PublicTaskProjection{}, false, ErrRevisionConflict
	}
	transitioned := !terminalTaskStatus(status)
	if transitioned {
		status = "cancelled"
		result, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_task SET status='cancelled',revision=revision+1,
			  current_sequence=current_sequence+3,failure_code='',completed_at=now(),updated_at=now()
			WHERE id=$1 AND revision=$2
			  AND status IN ('pending','waiting_executor','running','waiting_user_scan')
		`, input.TaskID, revision)
		if err != nil {
			return PublicTaskProjection{}, false, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return PublicTaskProjection{}, false, ErrRevisionConflict
		}
		if operationID != "" && leaseEpoch > 0 {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ky_ai_executor_operation_lease SET status='fenced',updated_at=now()
				WHERE executor_id=$1 AND operation_id=$2 AND lease_epoch=$3 AND status='active'
			`, executorID, operationID, leaseEpoch); err != nil {
				return PublicTaskProjection{}, false, err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_task_request_registry
			SET materialized_status='cancelled',materialized_at=COALESCE(materialized_at,now()),finalized_at=now()
			WHERE task_id=$1
		`, input.TaskID); err != nil {
			return PublicTaskProjection{}, false, err
		}
		meta := taskEventMeta{TaskID: input.TaskID, Status: status, WorkspaceType: input.WorkspaceType,
			WorkspaceID: input.WorkspaceID, ExecutorID: executorID, OperationID: operationID,
			LeaseEpoch: leaseEpoch, SourceCredentialRevision: sourceRevision, RevocationEpoch: revocationEpoch}
		if err := insertTaskEvent(ctx, tx, meta, sequence+1, TaskEventChanged, "warning", map[string]any{"status": status}); err != nil {
			return PublicTaskProjection{}, false, err
		}
		if err := insertTaskEvent(ctx, tx, meta, sequence+2, TaskEventTerminal, "warning", map[string]any{"status": status}); err != nil {
			return PublicTaskProjection{}, false, err
		}
		if err := insertTaskEvent(ctx, tx, meta, sequence+3, TaskEventClosed, "info", map[string]any{"reason": "terminal"}); err != nil {
			return PublicTaskProjection{}, false, err
		}
		if err := insertTerminalClosure(ctx, tx, input.TaskID, status, "Task cancelled"); err != nil {
			return PublicTaskProjection{}, false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_api_idempotency (
		  actor_id,action,scope_id,idempotency_key_hash,request_hash,
		  resource_type,resource_id,response_status
		) VALUES ($1,'cancel_task',$2,$3,$4,'executor_task',$2,200)
	`, input.ActorID, input.TaskID, input.IdempotencyKeyHash, input.RequestHash); err != nil {
		return PublicTaskProjection{}, false, classifyControlWrite(err)
	}
	if err := tx.Commit(); err != nil {
		return PublicTaskProjection{}, false, classifyControlWrite(err)
	}
	item, err := s.GetPublicTask(ctx, input.TaskID, input.WorkspaceType, input.WorkspaceID)
	return item, transitioned, err
}

type taskEventMeta struct {
	TaskID                   string
	Status                   string
	WorkspaceType            string
	WorkspaceID              string
	ExecutorID               string
	OperationID              string
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
}

func insertTaskEvent(ctx context.Context, tx *sql.Tx, meta taskEventMeta, sequence int64, eventType, level string, payload map[string]any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	id := derivedTaskID("task_event", meta.TaskID, sequence, eventType)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_event
		(id,task_id,sequence,event_type,level,message,payload_json,safe_payload_json,created_at)
		VALUES ($1,$2,$3,$4,$5,'',$6::jsonb,$6::jsonb,now())
	`, id, meta.TaskID, sequence, eventType, level, string(encoded)); err != nil {
		return err
	}
	reference, _ := json.Marshal(map[string]any{"taskId": meta.TaskID, "sequence": sequence, "status": meta.Status})
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_outbox (
		  id,task_id,task_sequence,event_type,task_status,executor_id,
		  workspace_type,workspace_id,safe_reference_json,operation_id,
		  lease_epoch,source_credential_revision,revocation_epoch,occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,now())
	`, derivedTaskID("task_outbox", meta.TaskID, sequence, eventType), meta.TaskID, sequence,
		eventType, meta.Status, meta.ExecutorID, meta.WorkspaceType, meta.WorkspaceID,
		string(reference), meta.OperationID, meta.LeaseEpoch, meta.SourceCredentialRevision,
		meta.RevocationEpoch)
	return err
}

func insertTerminalClosure(ctx context.Context, tx *sql.Tx, taskID, status, line string) error {
	var current int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(sequence),0) FROM ky_ai_executor_task_raw_log WHERE task_id=$1
	`, taskID).Scan(&current); err != nil {
		return err
	}
	payload := base64.StdEncoding.EncodeToString([]byte(line))
	frames := []map[string]any{
		{"projectionKind": "ansi_frame", "encoding": "base64", "payload": payload, "byteLength": len([]byte(line))},
		{"projectionKind": "terminal", "status": status},
		{"projectionKind": "closed", "reason": "terminal"},
	}
	for index, frame := range frames {
		sequence := current + int64(index) + 1
		encoded, _ := json.Marshal(frame)
		terminalLine := ""
		if index == 0 {
			terminalLine = line
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_task_raw_log
			(id,task_id,sequence,source,direction,raw_text,raw_json,terminal_line,created_at)
			VALUES ($1,$2,$3,'executor','internal','',$4::jsonb,$5,now())
		`, derivedTaskID("task_terminal", taskID, sequence, strconv.Itoa(index)), taskID,
			sequence, string(encoded), terminalLine); err != nil {
			return err
		}
	}
	return nil
}

func derivedTaskID(prefix, taskID string, sequence int64, discriminator string) string {
	sum := sha256.Sum256([]byte(prefix + "\n" + taskID + "\n" + strconv.FormatInt(sequence, 10) + "\n" + discriminator))
	return prefix + "_" + hex.EncodeToString(sum[:16])
}

func terminalTaskStatus(status string) bool {
	switch status {
	case "completed", "failed", "cancelled", "timeout":
		return true
	default:
		return false
	}
}
