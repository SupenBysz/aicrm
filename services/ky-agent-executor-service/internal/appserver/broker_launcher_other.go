//go:build !linux

package appserver

import (
	"context"
	"errors"
)

type BrokerLauncher struct{ SocketPath string }

func (BrokerLauncher) Launch(context.Context, string, string) (Process, error) {
	return nil, errors.New("runtime broker is supported only on Linux")
}
