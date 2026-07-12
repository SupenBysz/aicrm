//go:build linux

package credentialfs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type ExecutorLock struct {
	file *os.File
	once sync.Once
	err  error
}

func (m *Manager) AcquireExecutorLock(ctx context.Context, executorID string) (*ExecutorLock, error) {
	if !safeIDPattern.MatchString(executorID) {
		return nil, ErrInvalidPath
	}
	executorRoot := filepath.Join(m.root, executorID)
	if err := m.ensureContained(executorRoot); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(executorRoot, 0o700); err != nil {
		return nil, err
	}
	rootInfo, err := os.Lstat(executorRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, ErrInvalidPath
	}
	lockPath := filepath.Join(executorRoot, ".operation.lock")
	fd, err := unix.Open(lockPath, unix.O_RDWR|unix.O_CREAT|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, ErrInvalidPath
	}
	file := os.NewFile(uintptr(fd), lockPath)
	if file == nil {
		_ = unix.Close(fd)
		return nil, ErrInvalidPath
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 {
		_ = file.Close()
		return nil, ErrInvalidPath
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return &ExecutorLock{file: file}, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = file.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (l *ExecutorLock) Close() error {
	l.once.Do(func() {
		if err := unix.Flock(int(l.file.Fd()), unix.LOCK_UN); err != nil {
			l.err = err
		}
		if err := l.file.Close(); l.err == nil {
			l.err = err
		}
	})
	return l.err
}
