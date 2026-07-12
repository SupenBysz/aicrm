//go:build !linux

package appserver

import (
	"context"
	"errors"
)

type SystemdLauncher struct {
	SystemdRunPath string
	CodexBinary    string
	CredentialRoot string
}

func (SystemdLauncher) Launch(context.Context, string, string) (Process, error) {
	return nil, errors.New("server Codex runtime requires Linux systemd")
}
