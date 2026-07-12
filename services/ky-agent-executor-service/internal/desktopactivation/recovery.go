package desktopactivation

import (
	"context"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

const (
	DefaultRecoveryInterval  = 5 * time.Second
	DefaultRecoveryBatchSize = 64
)

type RecoveryStore interface {
	ReconcileDesktopCredentialActivations(context.Context, int) (store.DesktopActivationReconciliationResult, error)
}

type RecoveryConfig struct {
	Interval  time.Duration
	BatchSize int
}

type RecoveryRunner struct {
	store     RecoveryStore
	interval  time.Duration
	batchSize int
}

func NewRecoveryRunner(recoveryStore RecoveryStore, config RecoveryConfig) (*RecoveryRunner, error) {
	if recoveryStore == nil || config.Interval < 0 || config.BatchSize < 0 {
		return nil, ErrInvalidConfiguration
	}
	interval := config.Interval
	if interval == 0 {
		interval = DefaultRecoveryInterval
	}
	batchSize := config.BatchSize
	if batchSize == 0 {
		batchSize = DefaultRecoveryBatchSize
	}
	if batchSize > 256 {
		return nil, ErrInvalidConfiguration
	}
	return &RecoveryRunner{
		store: recoveryStore, interval: interval, batchSize: batchSize,
	}, nil
}

// Recover drains every currently actionable batch. Healthy pending
// activations are not returned by the Store and remain available for ACK.
func (r *RecoveryRunner) Recover(ctx context.Context) error {
	if r == nil || r.store == nil || r.batchSize <= 0 {
		return ErrInvalidConfiguration
	}
	for {
		result, err := r.store.ReconcileDesktopCredentialActivations(ctx, r.batchSize)
		if err != nil {
			return err
		}
		if result.Selected < r.batchSize {
			return nil
		}
	}
}

// Run performs startup recovery before entering the periodic five-second
// loop. The interval is configurable for deterministic tests. A reconciliation
// error is returned to the owner so it can fail closed instead of silently
// leaving ambiguous credential candidates behind.
func (r *RecoveryRunner) Run(ctx context.Context) error {
	if err := r.Recover(ctx); err != nil {
		return err
	}
	return r.RunPeriodic(ctx)
}

// RunPeriodic enters the steady-state loop after the owner has completed and
// published startup recovery. It intentionally does not repeat startup work.
func (r *RecoveryRunner) RunPeriodic(ctx context.Context) error {
	if r == nil || r.store == nil || r.interval <= 0 || r.batchSize <= 0 {
		return ErrInvalidConfiguration
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.Recover(ctx); err != nil {
				return err
			}
		}
	}
}
