package controltask

import (
	"bufio"
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

func TestManagerRunsControlTaskWithLeaseCOWStdioAndCredentialRotation(t *testing.T) {
	if controlTaskLeaseRenewalInterval != 10*time.Second {
		t.Fatalf("lease renewal interval=%s", controlTaskLeaseRenewalInterval)
	}
	credentials, err := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	if err != nil {
		t.Fatal(err)
	}
	staging, err := credentials.CreateStaging("aiexec_1", "auth_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalDigest, err := credentialfs.DigestTree(staging)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Promote("aiexec_1", "auth_1", 1, originalDigest); err != nil {
		t.Fatal(err)
	}
	email := "owner@example.com"
	work := store.ControlTaskWork{
		TaskID: "task_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExecutorID: "aiexec_1", TaskType: "model_catalog_refresh",
		OperationID: "control_task_1", OwnerInstanceID: "owner_1", LeaseEpoch: 3,
		ExecutorConfigRevision: 7, CredentialRevision: 1, CatalogRevision: 2,
		RuntimeBindingID: "server_1", RuntimeBindingRevision: 1, RevocationEpoch: 4,
		DefaultModelKey: "gpt-5.6", AccountFingerprint: digestString("chatgpt\n" + email),
		PlanType: "plus", AuthMode: "device_code", BindingDigest: originalDigest,
		TaskTimeoutSeconds: 30,
	}
	runtimeStore := newFakeRuntimeStore(work)
	launcher := &scriptedLauncher{email: email, mutateFirstOperation: true}
	manager, err := New(runtimeStore, launcher, credentials, Config{OwnerInstanceID: "owner_1", CodexVersion: "0.144.1"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.Start(ctx)
	manager.Wake()
	select {
	case completed := <-runtimeStore.completed:
		if completed.PromotedCredentialRevision == nil || *completed.PromotedCredentialRevision != 2 ||
			completed.PromotedBindingDigest == "" || len(completed.Models) != 1 ||
			completed.Models[0].ModelKey != "gpt-5.6" {
			t.Fatalf("completion=%#v", completed)
		}
	case failure := <-runtimeStore.failed:
		t.Fatalf("worker failed: %#v", failure)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not complete")
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	manager.Shutdown(shutdownCtx)
	if runtimeStore.startCalls != 1 || runtimeStore.prepareCalls != 1 ||
		runtimeStore.committingCalls != 1 || runtimeStore.renewCalls < 1 {
		t.Fatalf("store calls start=%d prepare=%d committing=%d renew=%d",
			runtimeStore.startCalls, runtimeStore.prepareCalls,
			runtimeStore.committingCalls, runtimeStore.renewCalls)
	}
	if len(launcher.operations) != 2 || launcher.operations[0] != work.OperationID ||
		launcher.operations[1] != work.OperationID {
		t.Fatalf("stdio operations=%v", launcher.operations)
	}
	original, _ := os.ReadFile(filepath.Join(credentials.Root(), "aiexec_1", "revisions", "1", "auth.json"))
	rotated, _ := os.ReadFile(filepath.Join(credentials.Root(), "aiexec_1", "revisions", "2", "auth.json"))
	if string(original) != "original" || string(rotated) != "rotated" {
		t.Fatalf("original=%q rotated=%q", original, rotated)
	}
	if err := credentialfs.ValidateReadOnlyTree(filepath.Join(credentials.Root(), "aiexec_1", "revisions", "2")); err != nil {
		t.Fatalf("rotated revision is writable: %v", err)
	}
	if _, err := os.Stat(filepath.Join(credentials.Root(), "aiexec_1", "operations", work.OperationID)); !os.IsNotExist(err) {
		t.Fatalf("verification COW was not removed: %v", err)
	}
}

func TestSanitizeModelsRejectsEmptyCatalog(t *testing.T) {
	if _, err := sanitizeModels(nil); err == nil {
		t.Fatal("empty model/list response was accepted")
	}
}

func TestManagerReportsAmbiguousCompletionError(t *testing.T) {
	credentials, _ := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := credentials.CreateStaging("aiexec_1", "auth_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	digest, _ := credentialfs.DigestTree(staging)
	_, _ = credentials.Promote("aiexec_1", "auth_1", 1, digest)
	email := "owner@example.com"
	work := store.ControlTaskWork{
		TaskID: "task_complete_error", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExecutorID: "aiexec_1", TaskType: "readiness_check", OperationID: "control_complete_error",
		OwnerInstanceID: "owner_1", LeaseEpoch: 1, ExecutorConfigRevision: 1,
		CredentialRevision: 1, CatalogRevision: 1, RuntimeBindingID: "server_1",
		RuntimeBindingRevision: 1, AccountFingerprint: digestString("chatgpt\n" + email),
		BindingDigest: digest, DefaultModelKey: "gpt-5.6", TaskTimeoutSeconds: 30,
	}
	runtimeStore := newFakeRuntimeStore(work)
	runtimeStore.completeErr = context.DeadlineExceeded
	reported := make(chan error, 1)
	manager, _ := New(runtimeStore, &scriptedLauncher{email: email}, credentials, Config{
		OwnerInstanceID: "owner_1", CodexVersion: "0.144.1", ReportError: func(err error) { reported <- err },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.Start(ctx)
	select {
	case err := <-reported:
		if err == nil || !strings.Contains(err.Error(), work.TaskID) {
			t.Fatalf("reported error=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ambiguous CompleteControlTask error was silently discarded")
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	manager.Shutdown(shutdownCtx)
}

func TestManagerCredentialVerifyRecordsExpiredWithoutPromotingCOW(t *testing.T) {
	credentials, _ := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := credentials.CreateStaging("aiexec_1", "auth_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	digest, _ := credentialfs.DigestTree(staging)
	_, _ = credentials.Promote("aiexec_1", "auth_1", 1, digest)
	work := store.ControlTaskWork{
		TaskID: "task_2", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExecutorID: "aiexec_1", TaskType: "credential_verify", OperationID: "control_task_2",
		OwnerInstanceID: "owner_1", LeaseEpoch: 4, ExecutorConfigRevision: 7,
		CredentialRevision: 1, CatalogRevision: 2, RuntimeBindingID: "server_1",
		RuntimeBindingRevision: 1, RevocationEpoch: 4, AccountFingerprint: digestString("chatgpt\nowner@example.com"),
		BindingDigest: digest, TaskTimeoutSeconds: 30,
	}
	runtimeStore := newFakeRuntimeStore(work)
	launcher := &scriptedLauncher{requiresAuth: true}
	manager, _ := New(runtimeStore, launcher, credentials, Config{OwnerInstanceID: "owner_1", CodexVersion: "0.144.1"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.Start(ctx)
	select {
	case completed := <-runtimeStore.completed:
		if completed.CredentialAuthorized == nil || *completed.CredentialAuthorized ||
			completed.PromotedCredentialRevision != nil {
			t.Fatalf("completion=%#v", completed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not complete expired verification")
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	manager.Shutdown(shutdownCtx)
	if runtimeStore.prepareCalls != 0 {
		t.Fatalf("expired credential created a revision: %d", runtimeStore.prepareCalls)
	}
}

func TestManagerCredentialVerifyAuthorizedDoesNotRequireModelCatalog(t *testing.T) {
	credentials, _ := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := credentials.CreateStaging("aiexec_1", "auth_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	digest, _ := credentialfs.DigestTree(staging)
	_, _ = credentials.Promote("aiexec_1", "auth_1", 1, digest)
	email := "owner@example.com"
	work := store.ControlTaskWork{
		TaskID: "task_verify_authorized", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExecutorID: "aiexec_1", TaskType: "credential_verify", OperationID: "control_verify_authorized",
		OwnerInstanceID: "owner_1", LeaseEpoch: 1, ExecutorConfigRevision: 7,
		CredentialRevision: 1, CatalogRevision: 2, RuntimeBindingID: "server_1",
		RuntimeBindingRevision: 1, RevocationEpoch: 4,
		AccountFingerprint: digestString("chatgpt\n" + email), BindingDigest: digest,
		TaskTimeoutSeconds: 30,
	}
	runtimeStore := newFakeRuntimeStore(work)
	manager, _ := New(runtimeStore, &scriptedLauncher{email: email}, credentials, Config{
		OwnerInstanceID: "owner_1", CodexVersion: "0.144.1",
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.Start(ctx)
	select {
	case completed := <-runtimeStore.completed:
		if completed.CredentialAuthorized == nil || !*completed.CredentialAuthorized ||
			len(completed.Models) != 0 {
			t.Fatalf("completion=%#v", completed)
		}
	case failure := <-runtimeStore.failed:
		t.Fatalf("authorized credential verification failed: %#v", failure)
	case <-time.After(5 * time.Second):
		t.Fatal("authorized credential verification did not complete")
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	manager.Shutdown(shutdownCtx)
}

func TestManagerCredentialVerifyExpiredReportsCompletionError(t *testing.T) {
	credentials, _ := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := credentials.CreateStaging("aiexec_1", "auth_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	digest, _ := credentialfs.DigestTree(staging)
	_, _ = credentials.Promote("aiexec_1", "auth_1", 1, digest)
	work := store.ControlTaskWork{
		TaskID: "task_verify_expired_error", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExecutorID: "aiexec_1", TaskType: "credential_verify", OperationID: "control_verify_expired_error",
		OwnerInstanceID: "owner_1", LeaseEpoch: 1, ExecutorConfigRevision: 7,
		CredentialRevision: 1, CatalogRevision: 2, RuntimeBindingID: "server_1",
		RuntimeBindingRevision: 1, RevocationEpoch: 4,
		AccountFingerprint: digestString("chatgpt\nowner@example.com"), BindingDigest: digest,
		TaskTimeoutSeconds: 30,
	}
	runtimeStore := newFakeRuntimeStore(work)
	runtimeStore.completeErr = context.DeadlineExceeded
	reported := make(chan error, 1)
	manager, _ := New(runtimeStore, &scriptedLauncher{requiresAuth: true}, credentials, Config{
		OwnerInstanceID: "owner_1", CodexVersion: "0.144.1", ReportError: func(err error) { reported <- err },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.Start(ctx)
	select {
	case err := <-reported:
		if err == nil || !strings.Contains(err.Error(), work.TaskID) {
			t.Fatalf("reported error=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unauthorized credential completion error was silently discarded")
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	defer shutdownCancel()
	manager.Shutdown(shutdownCtx)
}

type fakeRuntimeStore struct {
	mu              sync.Mutex
	work            store.ControlTaskWork
	claimed         bool
	startCalls      int
	renewCalls      int
	prepareCalls    int
	committingCalls int
	completed       chan store.CompleteControlTaskInput
	failed          chan fakeTaskFailure
	completeErr     error
	recoveryItems   []store.ControlTaskRecoveryItem
	recoveryIndex   int
	cleanupItems    []store.ControlTaskRecoveryItem
}

type fakeTaskFailure struct {
	status            string
	code              string
	credentialExpired bool
}

func newFakeRuntimeStore(work store.ControlTaskWork) *fakeRuntimeStore {
	return &fakeRuntimeStore{
		work: work, completed: make(chan store.CompleteControlTaskInput, 1),
		failed: make(chan fakeTaskFailure, 1),
	}
}

func (s *fakeRuntimeStore) ClaimControlTask(context.Context, string, string) (store.ControlTaskWork, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed {
		return store.ControlTaskWork{}, false, nil
	}
	s.claimed = true
	return s.work, true, nil
}

func (s *fakeRuntimeStore) ClaimExpiredControlTaskRecovery(context.Context, string, string) (store.ControlTaskRecoveryItem, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recoveryIndex >= len(s.recoveryItems) {
		return store.ControlTaskRecoveryItem{}, false, nil
	}
	item := s.recoveryItems[s.recoveryIndex]
	s.recoveryIndex++
	return item, true, nil
}

func (s *fakeRuntimeStore) ListControlTaskCredentialCleanup(context.Context) ([]store.ControlTaskRecoveryItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]store.ControlTaskRecoveryItem(nil), s.cleanupItems...), nil
}

func (s *fakeRuntimeStore) ReconcileTerminalControlTaskCredential(context.Context, store.ControlTaskWork) (store.ControlTaskRecoveryItem, bool, error) {
	return store.ControlTaskRecoveryItem{}, false, store.ErrExecutorFenced
}

func (s *fakeRuntimeStore) StartControlTask(context.Context, store.ControlTaskWork) error {
	s.mu.Lock()
	s.startCalls++
	s.mu.Unlock()
	return nil
}

func (s *fakeRuntimeStore) RenewControlTaskLease(context.Context, store.ControlTaskWork) error {
	s.mu.Lock()
	s.renewCalls++
	s.mu.Unlock()
	return nil
}

func (s *fakeRuntimeStore) PrepareControlTaskCredentialRotation(context.Context, store.ControlTaskWork, string) (int64, error) {
	s.mu.Lock()
	s.prepareCalls++
	s.mu.Unlock()
	return 2, nil
}

func (s *fakeRuntimeStore) MarkControlTaskCredentialCommitting(context.Context, store.ControlTaskWork, int64, string) error {
	s.mu.Lock()
	s.committingCalls++
	s.mu.Unlock()
	return nil
}

func (s *fakeRuntimeStore) CompleteControlTask(_ context.Context, input store.CompleteControlTaskInput) error {
	if s.completeErr != nil {
		return s.completeErr
	}
	s.completed <- input
	return nil
}

func (s *fakeRuntimeStore) FailControlTask(_ context.Context, _ store.ControlTaskWork, status, code string, credentialExpired bool) error {
	s.failed <- fakeTaskFailure{status: status, code: code, credentialExpired: credentialExpired}
	return nil
}

type scriptedLauncher struct {
	mu                   sync.Mutex
	email                string
	requiresAuth         bool
	mutateFirstOperation bool
	operations           []string
}

func (l *scriptedLauncher) Launch(_ context.Context, operationID, credentialHome string) (appserver.Process, error) {
	l.mu.Lock()
	l.operations = append(l.operations, operationID)
	mutate := l.mutateFirstOperation && !strings.HasSuffix(operationID, "_verify")
	l.mu.Unlock()
	if mutate {
		if err := os.WriteFile(filepath.Join(credentialHome, "auth.json"), []byte("rotated"), 0o600); err != nil {
			return nil, err
		}
	}
	return newScriptedProcess(l.email, l.requiresAuth), nil
}

type scriptedProcess struct {
	stdin     *io.PipeWriter
	stdout    *io.PipeReader
	done      chan struct{}
	closeOnce sync.Once
	waitOnce  sync.Once
	waitErr   error
}

func newScriptedProcess(email string, requiresAuth bool) *scriptedProcess {
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	process := &scriptedProcess{stdin: stdinWriter, stdout: stdoutReader, done: make(chan struct{})}
	go func() {
		defer close(process.done)
		defer stdoutWriter.Close()
		scanner := bufio.NewScanner(stdinReader)
		for scanner.Scan() {
			var request struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if json.Unmarshal(scanner.Bytes(), &request) != nil || len(request.ID) == 0 {
				continue
			}
			var result any
			switch request.Method {
			case appserver.MethodInitialize:
				result = map[string]any{"platformFamily": "unix", "platformOs": "linux", "userAgent": "test"}
			case appserver.MethodAccountRead:
				if requiresAuth {
					result = map[string]any{"account": nil, "requiresOpenaiAuth": true}
				} else {
					result = map[string]any{
						"account":            map[string]any{"type": "chatgpt", "email": email, "planType": "plus"},
						"requiresOpenaiAuth": false,
					}
				}
			case appserver.MethodModelList:
				result = map[string]any{
					"data": []map[string]any{{
						"id": "catalog_1", "model": "gpt-5.6", "displayName": "GPT-5.6",
						"hidden": false, "inputModalities": []string{"text", "image"},
						"supportedReasoningEfforts": []map[string]any{{"reasoningEffort": "high", "description": "High"}},
					}},
					"nextCursor": nil,
				}
			default:
				result = map[string]any{}
			}
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(request.ID), "result": result})
			_, _ = stdoutWriter.Write(append(response, '\n'))
		}
		_ = stdinReader.Close()
	}()
	return process
}

func (p *scriptedProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *scriptedProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *scriptedProcess) Kill() error {
	p.closeOnce.Do(func() { _ = p.stdin.Close() })
	return nil
}
func (p *scriptedProcess) Wait() error {
	p.waitOnce.Do(func() { <-p.done })
	return p.waitErr
}
