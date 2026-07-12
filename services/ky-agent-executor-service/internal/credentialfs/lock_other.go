//go:build !linux

package credentialfs

import (
	"context"
	"os"
	"path/filepath"
	"sync"
)

// ExecutorLock keeps tooling builds portable. The server runtime is Linux and
// uses the flock implementation in lock_linux.go.
type ExecutorLock struct {
	file *os.File
	once sync.Once
	err  error
}

func (m *Manager) AcquireExecutorLock(ctx context.Context, executorID string) (*ExecutorLock, error) {
	if err := ctx.Err(); err != nil || !safeIDPattern.MatchString(executorID) {
		return nil, ErrInvalidPath
	}
	executorRoot := filepath.Join(m.root, executorID)
	if err := os.MkdirAll(executorRoot, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(executorRoot, ".operation.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	return &ExecutorLock{file: file}, nil
}

func (l *ExecutorLock) Close() error {
	l.once.Do(func() { l.err = l.file.Close() })
	return l.err
}
