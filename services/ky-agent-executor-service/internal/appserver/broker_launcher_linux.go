//go:build linux

package appserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/brokerprotocol"
	"golang.org/x/sys/unix"
)

type BrokerLauncher struct {
	SocketPath string
}

type brokerProcess struct {
	stdin    *os.File
	stdout   *os.File
	control  *net.UnixConn
	killOnce sync.Once
	waitOnce sync.Once
	waitErr  error
	stopCtx  func() bool
}

func (p *brokerProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *brokerProcess) Stdout() io.ReadCloser { return p.stdout }

func (p *brokerProcess) Kill() error {
	p.killOnce.Do(func() {
		payload, _ := json.Marshal(brokerprotocol.Message{Version: brokerprotocol.Version, Type: brokerprotocol.MessageCancel})
		_ = p.control.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = p.control.WriteMsgUnix(payload, nil, nil)
		_ = p.control.SetWriteDeadline(time.Time{})
		_ = p.stdin.Close()
	})
	return nil
}

func (p *brokerProcess) Wait() error {
	p.waitOnce.Do(func() {
		if p.stopCtx != nil {
			p.stopCtx()
		}
		buffer := make([]byte, brokerprotocol.MaximumBytes)
		for {
			n, _, _, _, err := p.control.ReadMsgUnix(buffer, nil)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					p.waitErr = ErrClosed
				}
				break
			}
			var message brokerprotocol.Message
			if json.Unmarshal(buffer[:n], &message) != nil || message.Version != brokerprotocol.Version {
				p.waitErr = ErrProtocolUnsupported
				break
			}
			if message.Type == brokerprotocol.MessageExited {
				break
			}
			if message.Type == brokerprotocol.MessageFailed {
				p.waitErr = ErrClosed
				break
			}
		}
		_ = p.control.Close()
	})
	return p.waitErr
}

func (l BrokerLauncher) Launch(ctx context.Context, operationID, credentialHome string) (Process, error) {
	if l.SocketPath == "" {
		return nil, errors.New("runtime broker socket is required")
	}
	connection, err := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: l.SocketPath, Net: "unixpacket"})
	if err != nil {
		return nil, ErrClosed
	}
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		_ = stdinRead.Close()
		_ = stdinWrite.Close()
		_ = connection.Close()
		return nil, err
	}
	cleanup := func() {
		_ = stdinRead.Close()
		_ = stdinWrite.Close()
		_ = stdoutRead.Close()
		_ = stdoutWrite.Close()
		_ = connection.Close()
	}
	request, _ := json.Marshal(brokerprotocol.Message{
		Version: brokerprotocol.Version, Type: brokerprotocol.MessageLaunch,
		OperationID: operationID, CredentialHome: credentialHome,
	})
	rights := unix.UnixRights(int(stdinRead.Fd()), int(stdoutWrite.Fd()))
	_ = connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := connection.WriteMsgUnix(request, rights, nil); err != nil {
		cleanup()
		return nil, ErrClosed
	}
	_ = connection.SetWriteDeadline(time.Time{})
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()
	buffer := make([]byte, brokerprotocol.MaximumBytes)
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _, _, _, err := connection.ReadMsgUnix(buffer, nil)
	_ = connection.SetReadDeadline(time.Time{})
	if err != nil {
		cleanup()
		return nil, ErrClosed
	}
	var response brokerprotocol.Message
	if json.Unmarshal(buffer[:n], &response) != nil || response.Version != brokerprotocol.Version || response.Type != brokerprotocol.MessageStarted {
		cleanup()
		return nil, ErrClosed
	}
	process := &brokerProcess{stdin: stdinWrite, stdout: stdoutRead, control: connection}
	process.stopCtx = context.AfterFunc(ctx, func() { _ = process.Kill() })
	return process, nil
}
