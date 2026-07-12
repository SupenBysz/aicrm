package authorization

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type runtimeStoreFake struct {
	mu        sync.Mutex
	activated store.ActivateServerCredentialInput
	failed    string
	done      chan struct{}
}

func (f *runtimeStoreFake) MarkAuthorizationWaiting(_ context.Context, id, _, _ string, revision int64) (store.AuthorizationSessionProjection, error) {
	return store.AuthorizationSessionProjection{ID: id, ExecutorID: "executor_1", RuntimeType: "server", FlowType: "device_code", Status: "waiting_user", Revision: revision + 1, Sequence: 2, RequestedBy: "user_1", SessionDeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}, nil
}
func (f *runtimeStoreFake) MarkAuthorizationVerifying(_ context.Context, id, _ string, revision int64) (store.AuthorizationSessionProjection, error) {
	return store.AuthorizationSessionProjection{ID: id, ExecutorID: "executor_1", RuntimeType: "server", FlowType: "device_code", Status: "verifying", Revision: revision + 1, Sequence: 3, RequestedBy: "user_1", SessionDeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}, nil
}
func (f *runtimeStoreFake) PrepareServerCredential(_ context.Context, input store.CredentialPreparationInput) (store.CredentialPreparation, error) {
	return store.CredentialPreparation{ExecutorID: "executor_1", CredentialRevision: 1, SessionRevision: input.ExpectedSessionRevision + 1, LeaseEpoch: 1, BindingDigest: input.BindingDigest}, nil
}
func (f *runtimeStoreFake) MarkCredentialCommitting(context.Context, store.CredentialPreparation, string) error {
	return nil
}
func (f *runtimeStoreFake) ActivateServerCredential(_ context.Context, input store.ActivateServerCredentialInput) (store.AuthorizationSessionProjection, error) {
	f.mu.Lock()
	f.activated = input
	f.mu.Unlock()
	close(f.done)
	return store.AuthorizationSessionProjection{ID: input.SessionID, Status: "succeeded"}, nil
}
func (f *runtimeStoreFake) FailAuthorizationSession(_ context.Context, _ string, _ string, _ string, code string) (store.AuthorizationSessionProjection, error) {
	f.mu.Lock()
	f.failed = code
	f.mu.Unlock()
	select {
	case <-f.done:
	default:
		close(f.done)
	}
	return store.AuthorizationSessionProjection{Status: "failed"}, nil
}

type fakeLauncher struct{ complete chan struct{} }

func (l *fakeLauncher) Launch(_ context.Context, _ string, home string) (appserver.Process, error) {
	_ = os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"credential":"test"}`), 0o600)
	p := newProtocolProcess()
	go serveProtocol(p, l.complete)
	return p, nil
}

type protocolProcess struct {
	inR  *io.PipeReader
	inW  *io.PipeWriter
	outR *io.PipeReader
	outW *io.PipeWriter
	once sync.Once
}

func newProtocolProcess() *protocolProcess {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	return &protocolProcess{inR: inR, inW: inW, outR: outR, outW: outW}
}
func (p *protocolProcess) Stdin() io.WriteCloser { return p.inW }
func (p *protocolProcess) Stdout() io.ReadCloser { return p.outR }
func (p *protocolProcess) Wait() error           { return nil }
func (p *protocolProcess) Kill() error {
	p.once.Do(func() { _ = p.inR.Close(); _ = p.outW.Close() })
	return nil
}

func serveProtocol(p *protocolProcess, complete <-chan struct{}) {
	decoder := json.NewDecoder(p.inR)
	for {
		var request map[string]any
		if decoder.Decode(&request) != nil {
			return
		}
		method, _ := request["method"].(string)
		id, hasID := request["id"]
		if !hasID {
			continue
		}
		var result any = map[string]any{}
		switch method {
		case "account/login/start":
			result = map[string]any{"type": "chatgptDeviceCode", "loginId": "login-memory-only", "verificationUrl": "https://auth.openai.com/codex/device", "userCode": "ABCD-EFGH"}
		case "account/read":
			result = map[string]any{"account": map[string]any{"type": "chatgpt", "email": "person@example.com", "planType": "plus"}, "requiresOpenaiAuth": false}
		case "model/list":
			result = map[string]any{"data": []any{map[string]any{"id": "catalog_1", "model": "gpt-5.6", "displayName": "GPT-5.6", "hidden": false, "inputModalities": []string{"text", "image"}, "supportedReasoningEfforts": []any{map[string]any{"reasoningEffort": "high", "description": "safe"}}}}, "nextCursor": nil}
		}
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		_, _ = p.outW.Write(append(response, '\n'))
		if method == "account/login/start" {
			go func() {
				<-complete
				notification, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "account/login/completed", "params": map[string]any{"loginId": "login-memory-only", "success": true}})
				_, _ = p.outW.Write(append(notification, '\n'))
			}()
		}
	}
}

func TestManagerKeepsChallengeInMemoryAndPromotesVerifiedCredential(t *testing.T) {
	credentials, err := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	if err != nil {
		t.Fatal(err)
	}
	runtimeStore := &runtimeStoreFake{done: make(chan struct{})}
	launcher := &fakeLauncher{complete: make(chan struct{})}
	manager, err := New(runtimeStore, launcher, credentials, Config{OwnerInstanceID: "owner_1", CodexVersion: "0.144.1", RuntimeBindingID: "server_1", RuntimeBindingRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	session := store.AuthorizationSessionProjection{ID: "session_1", ExecutorID: "executor_1", RuntimeType: "server", FlowType: "device_code", Status: "starting", Revision: 1, Sequence: 1, RequestedBy: "user_1", SessionDeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
	if err := manager.Start(session); err != nil {
		t.Fatal(err)
	}
	var action UserAction
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		action, err = manager.UserAction("session_1", "user_1")
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil || action.UserCode != "ABCD-EFGH" || !strings.HasPrefix(action.VerificationURL, "https://auth.openai.com/") {
		t.Fatalf("action=%#v err=%v", action, err)
	}
	if _, err := manager.UserAction("session_1", "other"); err != ErrRequesterMismatch {
		t.Fatalf("requester mismatch err=%v", err)
	}
	close(launcher.complete)
	select {
	case <-runtimeStore.done:
	case <-time.After(5 * time.Second):
		t.Fatal("authorization did not finish")
	}
	runtimeStore.mu.Lock()
	activated, failed := runtimeStore.activated, runtimeStore.failed
	runtimeStore.mu.Unlock()
	if failed != "" {
		t.Fatalf("unexpected failure: %s", failed)
	}
	if strings.Contains(string(activated.AccountSummaryJSON), "person@example.com") {
		t.Fatalf("account summary leaked email: %s", activated.AccountSummaryJSON)
	}
	if len(activated.Models) != 1 || activated.Models[0].ModelKey != "gpt-5.6" || activated.Models[0].CatalogItemID != "catalog_1" {
		t.Fatalf("catalog=%#v", activated.Models)
	}
	revision, err := credentials.RevisionPath("executor_1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(revision, "auth.json")); err != nil {
		t.Fatal(err)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	manager.Shutdown(shutdownCtx)
}

func TestChallengeValidationAndCatalogSafety(t *testing.T) {
	for _, value := range []string{"http://auth.openai.com/device", "https://evil.example/device", "https://auth.openai.com@evil.example/device", "https://auth.openai.com/device?code=secret"} {
		if validVerificationURL(value) {
			t.Fatalf("unsafe URL accepted: %s", value)
		}
	}
	if !validVerificationURL("https://auth.openai.com/codex/device") {
		t.Fatal("official URL rejected")
	}
	if _, err := sanitizeModels([]appserver.Model{{CatalogItemID: "id", ModelKey: "gpt-5.6", InputModalities: []string{"audio"}}}); err == nil {
		t.Fatal("unsupported modality accepted")
	}
	email := "user@example.com"
	_, summary, _ := safeAccount(&appserver.Account{Type: "chatgpt", Email: &email, PlanType: "plus"})
	if strings.Contains(string(summary), email) || !strings.Contains(string(summary), "emailDomainHash") {
		t.Fatalf("unsafe summary: %s", summary)
	}
}
