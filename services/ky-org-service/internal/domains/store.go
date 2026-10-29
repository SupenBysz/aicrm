package domains

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Store struct{ DB *sql.DB }

func ID() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}

const columns = `id,agency_id,hostname,mode,state,revision,generation,challenge,challenge_expires_at,provider_id,observation,actor_id,workspace_id`

func scan(r interface{ Scan(...any) error }) (Binding, error) {
	var b Binding
	var raw []byte
	e := r.Scan(&b.ID, &b.AgencyID, &b.Hostname, &b.Mode, &b.State, &b.Revision, &b.Generation, &b.Challenge, &b.ExpiresAt, &b.ProviderID, &raw, &b.ActorID, &b.WorkspaceID)
	if errors.Is(e, sql.ErrNoRows) {
		return b, ErrNotFound
	}
	if e == nil {
		e = json.Unmarshal(raw, &b.Observation)
	}
	b.Tasks = []Task{}
	return b, e
}
func (s Store) List(ctx context.Context, agency string) ([]Binding, error) {
	rows, e := s.DB.QueryContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE agency_id=$1 AND state NOT IN ('detached','cancelled') ORDER BY CASE WHEN state IN ('active','degraded','suspended') THEN 0 WHEN state IN ('awaiting_verification','awaiting_dns','provisioning','ready') THEN 1 ELSE 2 END,created_at DESC LIMIT 20`, agency)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Binding{}
	for rows.Next() {
		b, e := scan(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
func (s Store) Get(ctx context.Context, agency, id string) (Binding, error) {
	b, e := scan(s.DB.QueryRowContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE id=$1 AND agency_id=$2`, id, agency))
	if e != nil {
		return b, e
	}
	rows, e := s.DB.QueryContext(ctx, `SELECT id,binding_id,generation,phase,state,attempts,message,next_at FROM ky_agency_domain_task WHERE binding_id=$1 ORDER BY created_at DESC LIMIT 15`, id)
	if e != nil {
		return b, e
	}
	defer rows.Close()
	for rows.Next() {
		var t Task
		if e = rows.Scan(&t.ID, &t.BindingID, &t.Generation, &t.Phase, &t.State, &t.Attempts, &t.Message, &t.NextAt); e != nil {
			return b, e
		}
		b.Tasks = append(b.Tasks, t)
	}
	return b, rows.Err()
}
func (s Store) Resolve(ctx context.Context, host string) (Binding, error) {
	return scan(s.DB.QueryRowContext(ctx, `SELECT `+strings.ReplaceAll(columns, ",", ",d.")+` FROM ky_agency_domain d WHERE hostname=$1 AND state IN ('active','degraded') AND EXISTS(SELECT 1 FROM ky_agency a WHERE a.id=d.agency_id AND a.status='normal' AND a.deleted_at IS NULL)`, host))
}

type Input struct {
	RequestID string `json:"-"`
	Hostname  string `json:"hostname"`
	Mode      string `json:"mode"`
	Revision  int64  `json:"revision"`
	Reason    string `json:"reason"`
	NSConsent bool   `json:"nsConsent"`
}

func (s Store) Command(ctx context.Context, actor, workspace, agency, id, action, key string, in Input) (Binding, error) {
	var out Binding
	if len(key) < 8 || len(key) > 128 || len([]rune(in.Reason)) > 450 {
		return out, ErrInvalid
	}
	raw, _ := json.Marshal(struct {
		Agency, ID, Action string
		Input              Input
	}{agency, id, action, in})
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "domain-command:"+actor+":"+workspace+":"+key); e != nil {
		return out, e
	}
	var oldHash string
	var result []byte
	e = tx.QueryRowContext(ctx, `SELECT request_hash,result FROM ky_agency_domain_command WHERE actor_id=$1 AND workspace_id=$2 AND command_key=$3`, actor, workspace, key).Scan(&oldHash, &result)
	if e == nil {
		if oldHash != hash {
			return out, ErrConflict
		}
		e = json.Unmarshal(result, &out)
		return out, e
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return out, e
	}
	var exists string
	var agencyEnabled bool
	if e = tx.QueryRowContext(ctx, `SELECT id,(status='normal' AND deleted_at IS NULL) FROM ky_agency WHERE id=$1 FOR UPDATE`, agency).Scan(&exists, &agencyEnabled); e != nil {
		return out, ErrNotFound
	}
	if !agencyEnabled && (action == "create" || action == "activate" || action == "resume") {
		return out, ErrConflict
	}
	if action == "create" {
		if in.Hostname == "" || in.Mode != "managed" || !in.NSConsent {
			return out, ErrInvalid
		}
		var count int
		if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM ky_agency_domain WHERE agency_id=$1 AND state IN ('awaiting_verification','awaiting_dns','provisioning','ready')`, agency).Scan(&count); e != nil {
			return out, e
		}
		if count > 0 {
			return out, ErrConflict
		}
		// Serialize hostname reservations across agencies as well as the per-agency lock.
		if _, e = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "domain-host:"+in.Hostname); e != nil {
			return out, e
		}
		if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM ky_agency_domain WHERE hostname=$1 AND state NOT IN ('cancelled','detached')`, in.Hostname).Scan(&count); e != nil {
			return out, e
		}
		if count > 0 {
			return out, ErrConflict
		}
		id = ID()
		_, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain(id,agency_id,hostname,mode,state,challenge,challenge_expires_at,actor_id,workspace_id) VALUES($1,$2,$3,$4,'awaiting_verification',$5,now()+interval '7 days',$6,$7)`, id, agency, in.Hostname, in.Mode, "kycrm-"+ID(), actor, workspace)
		if e != nil {
			return out, e
		}
	} else {
		out, e = scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE id=$1 AND agency_id=$2 FOR UPDATE`, id, agency))
		if e != nil {
			return out, e
		}
		if in.Revision != out.Revision {
			return out, ErrConflict
		}
		state := out.State
		switch action {
		case "check":
			if state == "detached" || state == "cancelled" {
				return out, ErrConflict
			}
			var recent bool
			if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency_domain_task WHERE binding_id=$1 AND updated_at>now()-interval '15 seconds')`, id).Scan(&recent); e != nil {
				return out, e
			}
			if recent {
				return out, ErrThrottled
			}
		case "activate":
			if state != "ready" {
				return out, ErrConflict
			}
			var fresh bool
			if e = tx.QueryRowContext(ctx, `SELECT updated_at>now()-interval '2 minutes' FROM ky_agency_domain WHERE id=$1`, id).Scan(&fresh); e != nil {
				return out, e
			}
			if !fresh || !out.ExpiresAt.After(time.Now()) {
				return out, ErrConflict
			}
			if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain SET state='detaching',generation=generation+1,revision=revision+1,updated_at=now() WHERE agency_id=$1 AND id<>$2 AND state IN ('active','degraded','suspended')`, agency, id); e != nil {
				return out, e
			}
			state = "active"
		case "suspend":
			if state != "active" && state != "degraded" {
				return out, ErrConflict
			}
			state = "suspended"
		case "resume":
			if state != "suspended" {
				return out, ErrConflict
			}
			state = "provisioning"
		case "detach", "cancel":
			if action == "cancel" && (state == "active" || state == "suspended" || state == "degraded") {
				return out, ErrConflict
			}
			if state == "detached" || state == "cancelled" || state == "detaching" {
				return out, ErrConflict
			}
			state = "detaching"
			var attempted bool
			if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency_domain_task WHERE binding_id=$1 AND attempts>0)`, id).Scan(&attempted); e != nil {
				return out, e
			}
			if !attempted && out.ProviderID == "" {
				state = "cancelled"
			}
		case "renew-challenge":
			if state == "active" || state == "degraded" || state == "detaching" || state == "detached" || state == "cancelled" {
				return out, ErrConflict
			}
			state = "awaiting_verification"
			if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain SET challenge=$2,challenge_expires_at=now()+interval '7 days' WHERE id=$1`, id, "kycrm-"+ID()); e != nil {
				return out, e
			}
		default:
			return out, ErrInvalid
		}
		if action != "check" && action != "cancel" && strings.TrimSpace(in.Reason) == "" {
			return out, ErrInvalid
		}
		// An explicit mutation fences all in-flight work before scheduling the replacement.
		if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain_task SET state='cancelled',updated_at=now() WHERE binding_id=$1 AND state IN ('queued','running')`, id); e != nil {
			return out, e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain SET state=$2,revision=revision+1,generation=generation+CASE WHEN $3 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`, id, state, action != "check" && action != "activate"); e != nil {
			return out, e
		}
	}
	out, e = scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE id=$1`, id))
	if e != nil {
		return out, e
	}
	if action != "suspend" && out.State != "cancelled" {
		_, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain_task(id,binding_id,generation) VALUES($1,$2,$3)`, ID(), id, out.Generation)
		if e != nil {
			return out, e
		}
	}
	// Reconcile replaced primary resources without losing the original generation audit.
	if action == "activate" {
		_, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain_task SET state='cancelled' WHERE binding_id IN(SELECT id FROM ky_agency_domain WHERE agency_id=$1 AND state='detaching' AND id<>$2) AND state IN ('queued','running')`, agency, id)
		if e != nil {
			return out, e
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain_task(id,binding_id,generation) SELECT md5(random()::text||clock_timestamp()::text),id,generation FROM ky_agency_domain WHERE agency_id=$1 AND state='detaching' AND id<>$2`, agency, id)
		if e != nil {
			return out, e
		}
	}
	details, _ := json.Marshal(map[string]any{"action": action, "hostname": out.Hostname, "state": out.State, "reason": in.Reason, "requestId": in.RequestID, "mode": out.Mode, "nsConsent": in.NSConsent, "generation": out.Generation})
	if _, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain_audit(binding_id,actor_id,action,details) VALUES($1,$2,$3,$4)`, id, actor, action, details); e != nil {
		return out, e
	}
	result, _ = json.Marshal(out)
	if _, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain_command VALUES($1,$2,$3,$4,$5)`, actor, workspace, key, hash, result); e != nil {
		return out, e
	}
	return out, tx.Commit()
}
func (s Store) ProbeBinding(ctx context.Context, host string) (Binding, error) {
	return scan(s.DB.QueryRowContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE hostname=$1 AND state IN ('awaiting_verification','awaiting_dns','provisioning','ready','active','degraded') AND EXISTS(SELECT 1 FROM ky_agency a WHERE a.id=ky_agency_domain.agency_id AND a.status='normal' AND a.deleted_at IS NULL)`, host))
}

type Workspace struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (s Store) WorkspaceScope(ctx context.Context, agency string, refs []Workspace) (bool, error) {
	var enabled bool
	if e := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency WHERE id=$1 AND status='normal' AND deleted_at IS NULL)`, agency).Scan(&enabled); e != nil || !enabled {
		return false, e
	}
	for _, w := range refs {
		if w.Type == "agency" && w.ID == agency {
			return true, nil
		}
		if w.Type == "enterprise" {
			var ok bool
			e := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_enterprise WHERE id=$1 AND agency_id=$2 AND status='normal' AND deleted_at IS NULL)`, w.ID, agency).Scan(&ok)
			if e != nil {
				return false, e
			}
			if ok {
				return true, nil
			}
		}
	}
	return false, nil
}
func (s Store) Summaries(ctx context.Context, ids []string) (map[string]map[string]string, error) {
	rows, e := s.DB.QueryContext(ctx, `SELECT DISTINCT ON(agency_id) agency_id,hostname,state FROM ky_agency_domain WHERE agency_id=ANY($1) AND state NOT IN ('detached','cancelled') ORDER BY agency_id,CASE WHEN state IN ('active','degraded','suspended') THEN 0 ELSE 1 END,created_at DESC`, ids)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := map[string]map[string]string{}
	for rows.Next() {
		var id, h, state string
		if e = rows.Scan(&id, &h, &state); e != nil {
			return nil, e
		}
		out[id] = map[string]string{"hostname": h, "state": state}
	}
	return out, rows.Err()
}
func (s Store) AllowedWorkspaces(ctx context.Context, agency string, refs []Workspace) ([]Workspace, error) {
	out := []Workspace{}
	var enabled bool
	if e := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency WHERE id=$1 AND status='normal' AND deleted_at IS NULL)`, agency).Scan(&enabled); e != nil || !enabled {
		return out, e
	}
	ids := []string{}
	for _, r := range refs {
		if r.Type == "agency" && r.ID == agency {
			out = append(out, r)
		}
		if r.Type == "enterprise" {
			ids = append(ids, r.ID)
		}
	}
	rows, e := s.DB.QueryContext(ctx, `SELECT id FROM ky_enterprise WHERE id=ANY($1) AND agency_id=$2 AND status='normal' AND deleted_at IS NULL`, ids, agency)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			return nil, e
		}
		out = append(out, Workspace{Type: "enterprise", ID: id})
	}
	return out, rows.Err()
}
