package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
)

type fakeDesktopActivationRecovery struct {
	recoverErr      error
	recoverDone     chan struct{}
	periodicStarted chan struct{}
	periodicResult  chan error
	recoverOnce     sync.Once
	periodicOnce    sync.Once
}

func newFakeDesktopActivationRecovery() *fakeDesktopActivationRecovery {
	return &fakeDesktopActivationRecovery{
		recoverDone: make(chan struct{}), periodicStarted: make(chan struct{}),
		periodicResult: make(chan error, 1),
	}
}

func (fake *fakeDesktopActivationRecovery) Recover(context.Context) error {
	fake.recoverOnce.Do(func() { close(fake.recoverDone) })
	return fake.recoverErr
}

func (fake *fakeDesktopActivationRecovery) RunPeriodic(ctx context.Context) error {
	fake.periodicOnce.Do(func() { close(fake.periodicStarted) })
	select {
	case <-ctx.Done():
		return nil
	case err := <-fake.periodicResult:
		return err
	}
}

type fakeHTTPServerLifecycle struct {
	recoveryDone  <-chan struct{}
	listenStarted chan struct{}
	orderFailure  chan struct{}
	stop          chan struct{}
	stopOnce      sync.Once
	shutdownCalls int
	closeCalls    int
}

func newFakeHTTPServerLifecycle(recoveryDone <-chan struct{}) *fakeHTTPServerLifecycle {
	return &fakeHTTPServerLifecycle{
		recoveryDone: recoveryDone, listenStarted: make(chan struct{}),
		orderFailure: make(chan struct{}, 1), stop: make(chan struct{}),
	}
}

func (fake *fakeHTTPServerLifecycle) ListenAndServe() error {
	if fake.recoveryDone != nil {
		select {
		case <-fake.recoveryDone:
		default:
			fake.orderFailure <- struct{}{}
		}
	}
	close(fake.listenStarted)
	<-fake.stop
	return http.ErrServerClosed
}

func (fake *fakeHTTPServerLifecycle) Shutdown(context.Context) error {
	fake.shutdownCalls++
	fake.stopOnce.Do(func() { close(fake.stop) })
	return nil
}

func (fake *fakeHTTPServerLifecycle) Close() error {
	fake.closeCalls++
	fake.stopOnce.Do(func() { close(fake.stop) })
	return nil
}

func TestActivationRecoveryStartupCompletesBeforeHTTPAndCancellationIsClean(t *testing.T) {
	recovery := newFakeDesktopActivationRecovery()
	httpServer := newFakeHTTPServerLifecycle(recovery.recoverDone)
	ctx, cancel := context.WithCancel(context.Background())
	var healthy atomic.Bool
	if started, err := recoverDesktopActivationsForStartup(ctx, recovery, &healthy); err != nil || !started {
		t.Fatalf("startup recovered=%v err=%v", started, err)
	}
	done := make(chan error, 1)
	go func() {
		done <- runHTTPServerWithActivationRecovery(ctx, httpServer, recovery, &healthy)
	}()
	waitLifecycleSignal(t, recovery.periodicStarted, "periodic recovery did not start")
	waitLifecycleSignal(t, httpServer.listenStarted, "HTTP server did not start")
	select {
	case <-httpServer.orderFailure:
		t.Fatal("HTTP started before activation recovery")
	default:
	}
	if !healthy.Load() {
		t.Fatal("recovery was not published healthy after startup")
	}
	cancel()
	if err := waitLifecycleResult(t, done); err != nil {
		t.Fatal(err)
	}
	if healthy.Load() || httpServer.shutdownCalls != 1 || httpServer.closeCalls != 0 {
		t.Fatalf("healthy=%v shutdown=%d close=%d",
			healthy.Load(), httpServer.shutdownCalls, httpServer.closeCalls)
	}
}

func TestActivationRecoveryStartupFailureNeverStartsHTTP(t *testing.T) {
	expected := errors.New("startup reconciliation failed")
	recovery := newFakeDesktopActivationRecovery()
	recovery.recoverErr = expected
	httpServer := newFakeHTTPServerLifecycle(recovery.recoverDone)
	var healthy atomic.Bool
	started, err := recoverDesktopActivationsForStartup(
		context.Background(), recovery, &healthy,
	)
	if !errors.Is(err, expected) || started || healthy.Load() {
		t.Fatalf("started=%v error=%v healthy=%v", started, err, healthy.Load())
	}
	select {
	case <-httpServer.listenStarted:
		t.Fatal("HTTP started after failed startup recovery")
	default:
	}
	select {
	case <-recovery.periodicStarted:
		t.Fatal("periodic recovery started after failed startup recovery")
	default:
	}
}

func TestActivationRecoveryCancelledDuringStartupExitsNormally(t *testing.T) {
	recovery := newFakeDesktopActivationRecovery()
	httpServer := newFakeHTTPServerLifecycle(recovery.recoverDone)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var healthy atomic.Bool
	if started, err := recoverDesktopActivationsForStartup(ctx, recovery, &healthy); err != nil || started {
		t.Fatalf("started=%v err=%v", started, err)
	}
	if healthy.Load() {
		t.Fatal("cancelled startup published recovery healthy")
	}
	select {
	case <-httpServer.listenStarted:
		t.Fatal("HTTP started after startup cancellation")
	default:
	}
}

func TestActivationRecoveryPeriodicFailureStopsHTTPAndFailsClosed(t *testing.T) {
	expected := errors.New("periodic reconciliation failed")
	recovery := newFakeDesktopActivationRecovery()
	httpServer := newFakeHTTPServerLifecycle(recovery.recoverDone)
	var healthy atomic.Bool
	if started, err := recoverDesktopActivationsForStartup(
		context.Background(), recovery, &healthy,
	); err != nil || !started {
		t.Fatalf("startup recovered=%v err=%v", started, err)
	}
	done := make(chan error, 1)
	go func() {
		done <- runHTTPServerWithActivationRecovery(
			context.Background(), httpServer, recovery, &healthy,
		)
	}()
	waitLifecycleSignal(t, recovery.periodicStarted, "periodic recovery did not start")
	waitLifecycleSignal(t, httpServer.listenStarted, "HTTP server did not start")
	if !healthy.Load() {
		t.Fatal("recovery was not healthy before periodic failure")
	}
	recovery.periodicResult <- expected
	if err := waitLifecycleResult(t, done); !errors.Is(err, expected) {
		t.Fatalf("error=%v", err)
	}
	if healthy.Load() || httpServer.shutdownCalls != 1 {
		t.Fatalf("healthy=%v shutdown=%d", healthy.Load(), httpServer.shutdownCalls)
	}
}

func TestReadOnlyLifecycleDoesNotRequireActivationRecovery(t *testing.T) {
	httpServer := newFakeHTTPServerLifecycle(nil)
	ctx, cancel := context.WithCancel(context.Background())
	var healthy atomic.Bool
	done := make(chan error, 1)
	go func() {
		done <- runHTTPServerWithActivationRecovery(ctx, httpServer, nil, &healthy)
	}()
	waitLifecycleSignal(t, httpServer.listenStarted, "read-only HTTP server did not start")
	if healthy.Load() {
		t.Fatal("read-only mode published a write recovery state")
	}
	cancel()
	if err := waitLifecycleResult(t, done); err != nil {
		t.Fatal(err)
	}
}

func TestReadyzRequiresHealthyActivationRecoveryInWriteMode(t *testing.T) {
	server := newWithControl(config.Config{
		WriteEnabled: true, InternalToken: "ready-internal",
		AuthTokenSecret:       "ready-auth-secret-that-is-long-enough",
		DeviceChallengeSecret: "ready-independent-device-challenge-secret",
	}, &fakeReader{}, &fakeControl{}, validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow))
	server.confirmationRuntime = &fakeOperationConfirmationRuntime{}
	server.handoffRuntime = &fakeDesktopHandoffRuntime{}
	server.revocationRuntime = &fakeCredentialRevocationRuntime{}
	server.activationRuntime = &fakeDesktopActivationRuntime{}
	server.desktopCommandRuntime = &fakeDesktopAuthorizationCommandRuntime{}
	installTrustedTokenTestReadiness(server)

	server.activationRecoveryHealthy.Store(false)
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable ||
		!strings.Contains(recorder.Body.String(), `"controlReady":false`) {
		t.Fatalf("unhealthy status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	server.activationRecoveryHealthy.Store(true)
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK ||
		!strings.Contains(recorder.Body.String(), `"controlReady":true`) {
		t.Fatalf("healthy status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func waitLifecycleSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal(failure)
	}
}

func waitLifecycleResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(time.Second):
		t.Fatal("lifecycle did not stop")
		return nil
	}
}
