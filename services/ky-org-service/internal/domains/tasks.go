package domains

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type Work struct {
	ProviderID string  `json:"providerId,omitempty"`
	Ready      bool    `json:"automationReady"`
	Binding    Binding `json:"binding"`
	Task       Task    `json:"task"`
	Lease      string  `json:"lease"`
}
type Observation struct {
	NameserverChangeRequired bool     `json:"nameserverChangeRequired,omitempty"`
	PlatformPending          bool     `json:"platformPending,omitempty"`
	Paused                   bool     `json:"paused,omitempty"`
	RetryAfterSeconds        int      `json:"retryAfterSeconds,omitempty"`
	OwnershipLost            bool     `json:"ownershipLost"`
	Verified                 bool     `json:"verified"`
	DNSReady                 bool     `json:"dnsReady"`
	TLSReady                 bool     `json:"tlsReady"`
	RouteReady               bool     `json:"routeReady"`
	Deleted                  bool     `json:"deleted"`
	ProviderID               string   `json:"providerId,omitempty"`
	Message                  string   `json:"message"`
	Records                  []Record `json:"records"`
	Nameservers              []string `json:"nameservers"`
}
type Record struct {
	Type  string `json:"type"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

func (s Store) Claim(ctx context.Context) (Work, error) {
	var out Work
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	var free bool
	if e = tx.QueryRowContext(ctx, `SELECT pg_try_advisory_xact_lock(728394711)`).Scan(&free); e != nil {
		return out, e
	}
	if !free {
		return out, ErrNotFound
	}
	var running bool
	if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency_domain_task WHERE lease_until>now())`).Scan(&running); e != nil {
		return out, e
	}
	if running {
		return out, ErrNotFound
	}
	_, e = tx.ExecContext(ctx, `WITH expired AS(UPDATE ky_agency_domain SET state='detaching',generation=generation+1,revision=revision+1,updated_at=now() WHERE id IN(SELECT id FROM ky_agency_domain WHERE state IN ('awaiting_verification','awaiting_dns','provisioning','ready') AND challenge_expires_at<now() LIMIT 100) RETURNING id) INSERT INTO ky_agency_domain_audit(binding_id,actor_id,action) SELECT id,'domain-worker','verification_expired' FROM expired`)
	if e != nil {
		return out, e
	}
	if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain_task t SET state='cancelled',updated_at=now() FROM ky_agency_domain d WHERE d.id=t.binding_id AND d.state='detaching' AND d.generation<>t.generation AND t.state IN ('queued','running')`); e != nil {
		return out, e
	}
	// Reconcile both active bindings and cleanup work after worker restarts.
	_, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain_task(id,binding_id,generation) SELECT md5(random()::text||d.id||clock_timestamp()::text),d.id,d.generation FROM ky_agency_domain d WHERE d.state NOT IN ('cancelled','suspended') AND (d.state<>'detached' OR d.updated_at<now()-interval '1 hour') AND NOT EXISTS(SELECT 1 FROM ky_agency_domain_task t WHERE t.binding_id=d.id AND (t.state IN ('queued','running') OR t.updated_at>now()-interval '5 minutes')) ON CONFLICT DO NOTHING`)
	if e != nil {
		return out, e
	}
	var id string
	e = tx.QueryRowContext(ctx, `SELECT id FROM ky_agency_domain_task WHERE (state='queued' AND next_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&id)
	if errors.Is(e, sql.ErrNoRows) {
		return out, ErrNotFound
	}
	if e != nil {
		return out, e
	}
	out.Lease = ID()
	e = tx.QueryRowContext(ctx, `UPDATE ky_agency_domain_task SET state='running',lease_token=$2,lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING id,binding_id,generation,phase,state,attempts,message,next_at`, id, out.Lease).Scan(&out.Task.ID, &out.Task.BindingID, &out.Task.Generation, &out.Task.Phase, &out.Task.State, &out.Task.Attempts, &out.Task.Message, &out.Task.NextAt)
	if e != nil {
		return out, e
	}
	out.Binding, e = scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE id=$1`, out.Task.BindingID))
	if e != nil {
		return out, e
	}
	out.ProviderID = out.Binding.ProviderID
	return out, tx.Commit()
}
func (s Store) Complete(ctx context.Context, work Work, o Observation, authorized bool) error {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var agency string
	if e = tx.QueryRowContext(ctx, `SELECT agency_id FROM ky_agency_domain WHERE id=$1`, work.Binding.ID).Scan(&agency); e != nil {
		return e
	}
	var status string
	if e = tx.QueryRowContext(ctx, `SELECT CASE WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE status END FROM ky_agency WHERE id=$1 FOR UPDATE`, agency).Scan(&status); e != nil {
		return e
	}
	b, e := scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM ky_agency_domain WHERE id=$1 FOR UPDATE`, work.Binding.ID))
	if e != nil {
		return e
	}
	var valid bool
	e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency_domain_task WHERE id=$1 AND binding_id=$2 AND generation=$3 AND state='running' AND lease_token=$4 AND lease_until>now())`, work.Task.ID, b.ID, b.Generation, work.Lease).Scan(&valid)
	if e != nil {
		return e
	}
	if !valid || work.Binding.Generation != b.Generation {
		return ErrConflict
	}
	state, phase := b.State, "verify"
	done := false
	if state == "detaching" || state == "detached" {
		phase = "cleanup"
		if o.Deleted {
			state = "detached"
			done = true
		}
	} else if state == "suspended" || state == "cancelled" {
		return ErrConflict
	} else if status != "normal" {
		state = "suspended"
		done = true
		o.Message = "机构已停用，入口已停止访问"
	} else if o.Paused {
		phase = "waiting_configuration"
	} else if o.Verified && o.DNSReady && o.TLSReady && o.RouteReady {
		phase = "complete"
		var other bool
		if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency_domain WHERE agency_id=$1 AND id<>$2 AND state IN ('active','degraded','suspended'))`, agency, b.ID).Scan(&other); e != nil {
			return e
		}
		if state == "active" || state == "degraded" {
			state = "active"
		} else {
			state = "ready"
			if !other && authorized && b.ExpiresAt.After(time.Now()) {
				state = "active"
			}
		}
		done = true
	} else if (state == "active" || state == "degraded") && o.OwnershipLost && work.Task.Attempts >= 3 {
		state = "suspended"
		done = true
		if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain SET generation=generation+1 WHERE id=$1`, b.ID); e != nil {
			return e
		}
	} else if state == "active" || state == "degraded" {
		state = "degraded"
	} else if o.PlatformPending {
		state = "provisioning"
		phase = "platform_configuration"
	} else if !o.Verified {
		state = "awaiting_verification"
	} else if !o.DNSReady {
		state = "awaiting_dns"
		phase = "dns"
	} else {
		state = "provisioning"
		phase = "certificate"
	}
	if o.Paused {
		message := o.Message
		_ = json.Unmarshal(mustJSON(b.Observation), &o)
		o.Message = message
		o.Paused = true
	}
	public := o
	public.ProviderID = ""
	raw, _ := json.Marshal(public)
	if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain SET state=$2,observation=$3,provider_id=CASE WHEN $4='' THEN provider_id ELSE $4 END,revision=revision+1,updated_at=now() WHERE id=$1`, b.ID, state, raw, o.ProviderID); e != nil {
		return e
	}
	taskState := "queued"
	if done {
		taskState = "done"
	}
	delay := time.Duration(20+work.Task.Attempts*10) * time.Second
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	if o.RetryAfterSeconds > 0 && o.RetryAfterSeconds <= 3600 && delay < time.Duration(o.RetryAfterSeconds)*time.Second {
		delay = time.Duration(o.RetryAfterSeconds) * time.Second
	}
	if _, e = tx.ExecContext(ctx, `UPDATE ky_agency_domain_task SET state=$2,phase=$3,message=$4,lease_token='',lease_until=NULL,next_at=now()+$5::interval,updated_at=now() WHERE id=$1`, work.Task.ID, taskState, phase, o.Message, delay.String()); e != nil {
		return e
	}
	if state != b.State {
		_, e = tx.ExecContext(ctx, `INSERT INTO ky_agency_domain_audit(binding_id,actor_id,action,details) VALUES($1,'domain-worker','state_changed',$2)`, b.ID, raw)
		if e != nil {
			return e
		}
	}
	return tx.Commit()
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
