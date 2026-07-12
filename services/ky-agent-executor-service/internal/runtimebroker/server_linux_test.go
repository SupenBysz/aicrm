//go:build linux

package runtimebroker

import (
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
)

func TestBrokerPassesOnlyAnonymousStdioPipes(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "credentials")
	home := filepath.Join(root, "executor_1", "staging", "session_1")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{CredentialRoot: root, AgentUser: current.Username, SystemctlPath: "/bin/true"})
	if err != nil {
		t.Fatal(err)
	}
	server.commandFactory = func(string, []string) *exec.Cmd { return exec.Command("/bin/cat") }
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: socket, Net: "unixpacket"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	process, err := (appserver.BrokerLauncher{SocketPath: socket}).Launch(context.Background(), "operation_1", home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := process.Stdin().Write([]byte("ping\n")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 5)
	if _, err := io.ReadFull(process.Stdout(), buffer); err != nil {
		t.Fatal(err)
	}
	if string(buffer) != "ping\n" {
		t.Fatalf("unexpected stdio: %q", buffer)
	}
	_ = process.Stdin().Close()
	_ = process.Kill()
	waitDone := make(chan error, 1)
	go func() { waitDone <- process.Wait() }()
	select {
	case err := <-waitDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("broker process did not exit")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("broker server did not stop")
	}
}

func TestBrokerRejectsBroadOrSymlinkCredentialHome(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "credentials")
	home := filepath.Join(root, "executor_1", "staging", "session_1")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{CredentialRoot: root, AgentUser: current.Username})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.validateCredentialHome(home); err == nil {
		t.Fatal("broad credential permissions accepted")
	}
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "executor_1", "staging", "linked")
	if err := os.Symlink(home, link); err != nil {
		t.Fatal(err)
	}
	if err := server.validateCredentialHome(link); err == nil {
		t.Fatal("symlink credential home accepted")
	}
}
