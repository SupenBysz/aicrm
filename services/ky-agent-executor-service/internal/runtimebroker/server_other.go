//go:build !linux

package runtimebroker

import "errors"

type Config struct{}
type Server struct{}

func New(Config) (*Server, error) {
	return nil, errors.New("runtime broker is supported only on Linux")
}
