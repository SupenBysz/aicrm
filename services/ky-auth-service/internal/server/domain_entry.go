package server

import (
	"context"
	"database/sql"
	"errors"
	sharedauth "github.com/Kysion/KyaiCRM/shared/auth"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"net/http"
	"time"
)

func (s *Server) domainSubjectDecision(ctx context.Context, actor string, e domainentry.Entry, wt, wid string) (bool, error) {
	if e.BindingID == "" {
		return true, nil
	}
	var out struct {
		Allowed bool `json:"allowed"`
	}
	err := domainentry.Call(ctx, s.cfg.MembershipServiceURL, s.cfg.InternalToken, "/internal/v1/domains/subject-access", map[string]string{"actorId": actor, "agencyId": e.AgencyID, "workspaceType": wt, "workspaceId": wid}, &out)
	return out.Allowed, err
}
func (s *Server) entrySessionAllowed(ctx context.Context, token string, entry domainentry.Entry, wt, wid string) bool {
	allowed, err := s.entrySessionDecision(ctx, token, entry, wt, wid)
	return err == nil && allowed
}
func (s *Server) entrySessionDecision(ctx context.Context, token string, entry domainentry.Entry, wt, wid string) (bool, error) {
	if s.store == nil {
		return false, errors.New("auth store unavailable")
	}
	payload, e := sharedauth.VerifyToken(s.cfg.AuthTokenSecret, token)
	if e != nil {
		return false, nil
	}
	active, e := s.store.IsSessionActive(ctx, payload.SessionID, time.Now())
	if e != nil {
		return false, e
	}
	if !active {
		return false, nil
	}
	user, e := s.store.GetUserByID(ctx, payload.UserID)
	if errors.Is(e, sql.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if user.Status != "normal" {
		return false, nil
	}
	stored, e := s.store.SessionEntry(ctx, payload.SessionID)
	if e != nil {
		return false, e
	}
	if stored.BindingID == "" {
		return entry.BindingID == "", nil
	}
	if entry.BindingID == "" || stored.BindingID != entry.BindingID || stored.Generation != entry.Generation || stored.Host != entry.Host || stored.AgencyID != entry.AgencyID {
		return false, nil
	}
	var current domainentry.Entry
	if e = domainentry.Call(ctx, s.cfg.OrgServiceURL, s.cfg.InternalToken, "/internal/v1/domains/resolve", map[string]string{"host": entry.Host}, &current); e != nil {
		if domainentry.FailureStatus(e) == 403 {
			return false, nil
		}
		return false, e
	}
	if current != entry {
		return false, nil
	}
	return s.domainSubjectDecision(ctx, payload.UserID, entry, wt, wid)
}
func (s *Server) domainSessionAccess(w http.ResponseWriter, r *http.Request) {
	if !domainentry.Internal(r, s.cfg.InternalToken) {
		writeError(w, r, 401, "unauthorized", "内部认证失败")
		return
	}
	var in struct {
		Token         string            `json:"token"`
		Entry         domainentry.Entry `json:"entry"`
		WorkspaceType string            `json:"workspaceType"`
		WorkspaceID   string            `json:"workspaceId"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	allowed, err := s.entrySessionDecision(r.Context(), in.Token, in.Entry, in.WorkspaceType, in.WorkspaceID)
	if err != nil {
		domainentry.Fail(w, 503)
		return
	}
	writeData(w, r, map[string]bool{"allowed": allowed})
}
func (s *Server) publicDomainEntry(w http.ResponseWriter, r *http.Request) {
	entry := domainentry.From(r.Context())
	if entry.BindingID == "" {
		writeData(w, r, map[string]any{"institution": false})
		return
	}
	var brand jsonBrand
	if err := domainentry.Call(r.Context(), s.cfg.OrgServiceURL, s.cfg.InternalToken, "/internal/v1/agencies/"+entry.AgencyID+"/branding", map[string]any{}, &brand); err != nil {
		domainentry.Fail(w, 503)
		return
	}
	if _, ok := brand["effectiveBrand"].(map[string]any); !ok {
		domainentry.Fail(w, 503)
		return
	}
	safe := map[string]any{}

	if published, ok := brand["effectiveBrand"].(map[string]any); ok {
		for _, k := range []string{"name", "applicationName", "icon", "wordmark", "copyrightHolder", "copyrightStyle", "source", "effectiveFingerprint", "wordmarkGenerated"} {
			safe[k] = published[k]
		}
	}
	writeData(w, r, map[string]any{"institution": true, "brand": safe})
}

type jsonBrand map[string]any

func (s *Server) domainWorkspaceSet(ctx context.Context, actor string, e domainentry.Entry) (map[string]bool, error) {
	if e.BindingID == "" {
		return nil, nil
	}
	var out struct {
		Workspaces []struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"workspaces"`
	}
	err := domainentry.Call(ctx, s.cfg.MembershipServiceURL, s.cfg.InternalToken, "/internal/v1/domains/subject-access", map[string]string{"actorId": actor, "agencyId": e.AgencyID}, &out)
	if err != nil {
		return nil, err
	}
	result := map[string]bool{}
	for _, w := range out.Workspaces {
		result[w.Type+":"+w.ID] = true
	}
	return result, nil
}

func (s *Server) domainActorStatus(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		domainentry.Fail(w, 503)
		return
	}
	if !domainentry.Internal(r, s.cfg.InternalToken) {
		domainentry.Fail(w, 403)
		return
	}
	var in struct {
		ActorID string `json:"actorId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.ActorID == "" || len(in.ActorID) > 160 {
		domainentry.Fail(w, 403)
		return
	}
	u, err := s.store.GetUserByID(r.Context(), in.ActorID)
	if errors.Is(err, sql.ErrNoRows) {
		writeData(w, r, map[string]bool{"ready": false})
		return
	}
	if err != nil {
		domainentry.Fail(w, 503)
		return
	}
	writeData(w, r, map[string]bool{"ready": u.Status == "normal"})
}
