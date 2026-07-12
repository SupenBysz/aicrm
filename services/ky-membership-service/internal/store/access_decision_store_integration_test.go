package store

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"
)

func TestAccessAssuranceAgainstPostgres(t *testing.T) {
	readerURL := os.Getenv("KY_MEMBERSHIP_ASSURANCE_TEST_DATABASE_URL")
	fixtureURL := os.Getenv("KY_MEMBERSHIP_ASSURANCE_FIXTURE_DATABASE_URL")
	if readerURL == "" || fixtureURL == "" {
		t.Skip("set membership assurance PostgreSQL test URLs")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	reader, err := Open(ctx, readerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	fixture, err := Open(ctx, fixtureURL)
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()

	if _, err := reader.db.ExecContext(ctx, `UPDATE ky_user_session SET updated_at=now() WHERE id='session_assurance_owner_fresh'`); err == nil {
		t.Fatal("least-privilege access reader unexpectedly mutated a session")
	}

	legacy, err := reader.EvaluateAccessDecision(ctx, AccessDecisionRequest{
		ActorID: "user_assurance_owner", SessionID: "session_assurance_owner_fresh",
		WorkspaceType: "platform", WorkspaceID: "platform_root",
	})
	if err != nil || !legacy.Allowed || legacy.Assurance != nil {
		t.Fatalf("legacy decision=%#v err=%v", legacy, err)
	}

	highRisk := AccessDecisionRequest{
		ActorID: "user_assurance_owner", SessionID: "session_assurance_owner_fresh",
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		Assurance: &AccessAssuranceRequirements{
			RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: 600, RequireMFAIfEnabled: true,
		},
	}
	allowed, err := reader.EvaluateAccessDecision(ctx, highRisk)
	if err != nil || !allowed.Allowed || allowed.Assurance == nil || !allowed.Assurance.Verified ||
		!allowed.Assurance.WorkspaceOwner || allowed.Assurance.MFARequired {
		t.Fatalf("allowed=%#v err=%v", allowed, err)
	}

	admin := highRisk
	admin.ActorID, admin.SessionID = "user_assurance_admin", "session_assurance_admin_fresh"
	assertAssuranceDenied(t, reader, ctx, admin, "owner_required")
	old := highRisk
	old.SessionID = "session_assurance_owner_old"
	assertAssuranceDenied(t, reader, ctx, old, "fresh_login_required")
	future := highRisk
	future.SessionID = "session_assurance_owner_future"
	assertAssuranceDenied(t, reader, ctx, future, "fresh_login_required")
	wrongSession := highRisk
	wrongSession.SessionID = "session_assurance_admin_fresh"
	assertAssuranceDenied(t, reader, ctx, wrongSession, "session_inactive")

	crossWorkspaceRole := AccessDecisionRequest{
		ActorID: "user_assurance_cross", SessionID: "session_assurance_cross_fresh",
		WorkspaceType: "agency", WorkspaceID: "agency_assurance_target",
		Assurance: &AccessAssuranceRequirements{RequireWorkspaceOwner: true},
	}
	assertAssuranceDenied(t, reader, ctx, crossWorkspaceRole, "owner_required")
	nonSystemOwner := AccessDecisionRequest{
		ActorID: "user_assurance_nonsystem", SessionID: "session_assurance_nonsystem_fresh",
		WorkspaceType: "agency", WorkspaceID: "agency_assurance_target",
		Assurance: &AccessAssuranceRequirements{RequireWorkspaceOwner: true},
	}
	assertAssuranceDenied(t, reader, ctx, nonSystemOwner, "owner_required")

	boundaryTx, err := fixture.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer boundaryTx.Rollback()
	if _, err := boundaryTx.ExecContext(ctx, `
		INSERT INTO ky_user_session (
		 id,user_id,token_id,status,expires_at,created_at,updated_at,authenticated_at
		) VALUES
		 ('session_assurance_boundary_exact','user_assurance_owner','token_assurance_boundary_exact','active',
		  transaction_timestamp()+interval '1 hour',transaction_timestamp(),transaction_timestamp(),
		  transaction_timestamp()-interval '600 seconds'),
		 ('session_assurance_boundary_over','user_assurance_owner','token_assurance_boundary_over','active',
		  transaction_timestamp()+interval '1 hour',transaction_timestamp(),transaction_timestamp(),
		  transaction_timestamp()-interval '600 seconds'-interval '1 microsecond')
	`); err != nil {
		t.Fatal(err)
	}
	exactRequest := highRisk
	exactRequest.SessionID = "session_assurance_boundary_exact"
	exactBoundary, err := evaluateAccessDecisionTx(ctx, boundaryTx, exactRequest)
	if err != nil || !exactBoundary.Allowed || exactBoundary.Assurance == nil || !exactBoundary.Assurance.Verified {
		t.Fatalf("exact 600-second boundary=%#v err=%v", exactBoundary, err)
	}
	overRequest := highRisk
	overRequest.SessionID = "session_assurance_boundary_over"
	overBoundary, err := evaluateAccessDecisionTx(ctx, boundaryTx, overRequest)
	if err != nil || overBoundary.Allowed || overBoundary.ReasonCode != "fresh_login_required" {
		t.Fatalf("over boundary=%#v err=%v", overBoundary, err)
	}
	if err := boundaryTx.Rollback(); err != nil {
		t.Fatal(err)
	}

	authenticatedAtBefore := allowed.Assurance.AuthenticatedAt
	if _, err := fixture.db.ExecContext(ctx, `
		UPDATE ky_user_session SET authenticated_at=authenticated_at+interval '1 second'
		WHERE id='session_assurance_owner_fresh'
	`); err == nil {
		t.Fatal("authenticated_at immutability trigger accepted a session refresh rewrite")
	}
	if _, err := fixture.db.ExecContext(ctx, `
		UPDATE ky_user_session
		SET expires_at=expires_at+interval '5 minutes',updated_at=transaction_timestamp()
		WHERE id='session_assurance_owner_fresh'
	`); err != nil {
		t.Fatal(err)
	}
	refreshed, err := reader.EvaluateAccessDecision(ctx, highRisk)
	if err != nil || refreshed.Assurance == nil || refreshed.Assurance.AuthenticatedAt != authenticatedAtBefore {
		t.Fatalf("session refresh changed authenticatedAt before=%s decision=%#v err=%v", authenticatedAtBefore, refreshed, err)
	}

	if _, err := fixture.db.ExecContext(ctx, `
		UPDATE ky_system_setting
		SET setting_value=jsonb_set(setting_value,'{mfaEnabled}','true'::jsonb,true),updated_at=now()
		WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security'
	`); err != nil {
		t.Fatal(err)
	}
	assertAssuranceDenied(t, reader, ctx, highRisk, "mfa_required")
	mfaVerified := highRisk
	mfaVerified.SessionID = "session_assurance_owner_mfa"
	mfaDecision, err := reader.EvaluateAccessDecision(ctx, mfaVerified)
	if err != nil || !mfaDecision.Allowed || mfaDecision.Assurance == nil ||
		!mfaDecision.Assurance.MFARequired || !mfaDecision.Assurance.MFAVerified {
		t.Fatalf("MFA decision=%#v err=%v", mfaDecision, err)
	}
	mfaFuture := highRisk
	mfaFuture.SessionID = "session_assurance_owner_mfa_future"
	assertAssuranceDenied(t, reader, ctx, mfaFuture, "mfa_required")

	legacyWithMFAEnabled, err := reader.EvaluateAccessDecision(ctx, AccessDecisionRequest{
		ActorID: "user_assurance_owner", SessionID: "session_assurance_owner_fresh",
		WorkspaceType: "platform", WorkspaceID: "platform_root",
	})
	if err != nil || !legacyWithMFAEnabled.Allowed || legacyWithMFAEnabled.Assurance != nil {
		t.Fatalf("MFA setting changed legacy decision=%#v err=%v", legacyWithMFAEnabled, err)
	}
	if _, err := fixture.db.ExecContext(ctx, `
		UPDATE ky_system_setting
		SET setting_value=jsonb_set(setting_value,'{mfaEnabled}','false'::jsonb,true),updated_at=now()
		WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security'
	`); err != nil {
		t.Fatal(err)
	}
}

func assertAssuranceDenied(
	t *testing.T,
	control *Store,
	ctx context.Context,
	request AccessDecisionRequest,
	reason string,
) {
	t.Helper()
	decision, err := control.EvaluateAccessDecision(ctx, request)
	if err != nil || decision.Allowed || decision.ReasonCode != reason {
		t.Fatalf("reason=%s decision=%#v err=%v", reason, decision, err)
	}
	if reason != "session_inactive" && decision.Assurance == nil {
		t.Fatal("active assurance denial omitted safe facts")
	}
}
