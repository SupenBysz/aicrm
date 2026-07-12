package desktopactivation

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type recoveryStoreStub struct {
	mu      sync.Mutex
	results []store.DesktopActivationReconciliationResult
	err     error
	calls   chan int
}

func (stub *recoveryStoreStub) ReconcileDesktopCredentialActivations(
	_ context.Context,
	limit int,
) (store.DesktopActivationReconciliationResult, error) {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.calls != nil {
		select {
		case stub.calls <- limit:
		default:
		}
	}
	if stub.err != nil {
		return store.DesktopActivationReconciliationResult{}, stub.err
	}
	if len(stub.results) == 0 {
		return store.DesktopActivationReconciliationResult{}, nil
	}
	result := stub.results[0]
	stub.results = stub.results[1:]
	return result, nil
}

func TestRecoveryRunnerUsesLockedDefaultsAndValidatesConfiguration(t *testing.T) {
	stub := &recoveryStoreStub{}
	runner, err := NewRecoveryRunner(stub, RecoveryConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if runner.interval != 5*time.Second || runner.batchSize != 64 {
		t.Fatalf("defaults interval=%s batch=%d", runner.interval, runner.batchSize)
	}
	for _, config := range []RecoveryConfig{
		{Interval: -time.Second}, {BatchSize: -1}, {BatchSize: 257},
	} {
		if _, err := NewRecoveryRunner(stub, config); !errors.Is(err, ErrInvalidConfiguration) {
			t.Fatalf("config=%#v error=%v", config, err)
		}
	}
	if _, err := NewRecoveryRunner(nil, RecoveryConfig{}); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("nil store error=%v", err)
	}
}

func TestRecoveryRunnerDrainsBoundedBatches(t *testing.T) {
	stub := &recoveryStoreStub{results: []store.DesktopActivationReconciliationResult{
		{Selected: 2, Reconciled: 2},
		{Selected: 2, Reconciled: 2},
		{Selected: 1, Reconciled: 1},
	}, calls: make(chan int, 4)}
	runner, err := NewRecoveryRunner(stub, RecoveryConfig{BatchSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stub.calls) != 3 {
		t.Fatalf("reconcile calls=%d", len(stub.calls))
	}
	for len(stub.calls) > 0 {
		if limit := <-stub.calls; limit != 2 {
			t.Fatalf("batch limit=%d", limit)
		}
	}
}

func TestRecoveryRunnerDrainsSelectedBacklogAfterConcurrentWinner(t *testing.T) {
	stub := &recoveryStoreStub{results: []store.DesktopActivationReconciliationResult{
		{Selected: 2, Reconciled: 0},
		{Selected: 1, Reconciled: 1},
	}, calls: make(chan int, 3)}
	runner, err := NewRecoveryRunner(stub, RecoveryConfig{BatchSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stub.calls) != 2 {
		t.Fatalf("selected backlog calls=%d", len(stub.calls))
	}
}

func TestRecoveryRunnerRunsAtInjectedIntervalAndStopsWithContext(t *testing.T) {
	stub := &recoveryStoreStub{calls: make(chan int, 8)}
	runner, err := NewRecoveryRunner(stub, RecoveryConfig{
		Interval: time.Millisecond, BatchSize: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	for index := 0; index < 2; index++ {
		select {
		case limit := <-stub.calls:
			if limit != 3 {
				t.Fatalf("batch limit=%d", limit)
			}
		case <-time.After(time.Second):
			t.Fatal("periodic reconciliation did not run")
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("runner did not stop")
	}
}

func TestRecoveryRunnerPeriodicModeDoesNotRepeatStartup(t *testing.T) {
	stub := &recoveryStoreStub{calls: make(chan int, 1)}
	runner, err := NewRecoveryRunner(stub, RecoveryConfig{
		Interval: time.Hour, BatchSize: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runner.RunPeriodic(ctx); err != nil {
		t.Fatal(err)
	}
	if len(stub.calls) != 0 {
		t.Fatal("periodic mode repeated startup reconciliation")
	}
}

func TestRecoveryRunnerReturnsStoreFailure(t *testing.T) {
	expected := errors.New("database unavailable")
	runner, err := NewRecoveryRunner(&recoveryStoreStub{err: expected}, RecoveryConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); !errors.Is(err, expected) {
		t.Fatalf("run error=%v", err)
	}
}
