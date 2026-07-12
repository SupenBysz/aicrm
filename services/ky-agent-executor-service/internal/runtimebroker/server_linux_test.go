//go:build linux

package runtimebroker

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"golang.org/x/sys/unix"
)

func TestBrokerPassesOnlyAnonymousStdioPipes(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "credentials")
	stateRoot := filepath.Join(t.TempDir(), "state")
	home := filepath.Join(root, "executor_1", "staging", "session_1")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Chmod(root, credentialAnchorMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{CredentialRoot: root, RuntimeStateRoot: stateRoot, AgentUser: current.Username, SystemctlPath: "/bin/true"})
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
	if info, err := os.Stat(home); err != nil || !info.IsDir() {
		t.Fatal("credential home was not restored")
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
	stateRoot := filepath.Join(t.TempDir(), "state")
	home := filepath.Join(root, "executor_1", "staging", "session_1")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := unix.Chmod(root, credentialAnchorMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{CredentialRoot: root, RuntimeStateRoot: stateRoot, AgentUser: current.Username})
	if err != nil {
		t.Fatal(err)
	}
	if locked, err := server.lockCredentialHome(home, "operation_1"); err == nil {
		locked.close()
		t.Fatal("broad credential permissions accepted")
	}
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "executor_1", "staging", "linked")
	if err := os.Symlink(home, link); err != nil {
		t.Fatal(err)
	}
	if locked, err := server.lockCredentialHome(link, "operation_2"); err == nil {
		locked.close()
		t.Fatal("symlink credential home accepted")
	}
}

func TestRecoverOrphansRemovesPrivateRuntimeState(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "credentials")
	stateRoot := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Chmod(root, credentialAnchorMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	orphan := filepath.Join(stateRoot, "operation_orphan")
	if err := os.Mkdir(orphan, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "auth.json"), []byte("test-only"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{CredentialRoot: root, RuntimeStateRoot: stateRoot, AgentUser: current.Username})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.RecoverOrphans(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("orphan runtime state was not removed")
	}
}

func TestInstalledRecoverOrphansRestoresBrokerOwnedHomes(t *testing.T) {
	if os.Getenv("KY_TEST_INSTALLED_RUNTIME_BROKER_RECOVERY") != "1" {
		t.Skip("set installed runtime broker recovery flag")
	}
	server, err := New(Config{
		CredentialRoot:   "/var/lib/aicrm-agent-executors",
		RuntimeStateRoot: "/var/lib/private/aicrm-codex-runtime",
		AgentUser:        "ky-agent-executor",
		SystemctlPath:    "/usr/bin/systemctl",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.RecoverOrphans(); err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir("/var/lib/aicrm-agent-executors", func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() || (filepath.Base(filepath.Dir(path)) != "staging" && filepath.Base(filepath.Dir(path)) != "operations") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != server.agentUID {
			return errors.New("broker-owned credential home remains after recovery")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCopyDirectoryTreePreservesFilesAndRejectsHardlinks(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	destination := filepath.Join(t.TempDir(), "destination")
	if err := os.Mkdir(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(source, ".state"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, ".state", "auth.json"), []byte("credential-test"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceFD, err := unix.Open(source, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(sourceFD)
	destinationFD, err := unix.Open(destination, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(destinationFD)
	if err := copyDirectoryTree(sourceFD, destinationFD, &treeLimits{}); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(filepath.Join(destination, ".state", "auth.json"))
	if err != nil || string(payload) != "credential-test" {
		t.Fatal("credential file was not copied exactly")
	}

	hardlinkSource := filepath.Join(t.TempDir(), "hardlink-source")
	hardlinkDestination := filepath.Join(t.TempDir(), "hardlink-destination")
	if err := os.Mkdir(hardlinkSource, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(hardlinkDestination, 0o700); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(hardlinkSource, "first")
	if err := os.WriteFile(first, []byte("unsafe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(first, filepath.Join(hardlinkSource, "second")); err != nil {
		t.Fatal(err)
	}
	hardlinkSourceFD, _ := unix.Open(hardlinkSource, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	hardlinkDestinationFD, _ := unix.Open(hardlinkDestination, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	defer unix.Close(hardlinkSourceFD)
	defer unix.Close(hardlinkDestinationFD)
	if err := copyDirectoryTree(hardlinkSourceFD, hardlinkDestinationFD, &treeLimits{}); err == nil {
		t.Fatal("hardlinked credential file was accepted")
	}
}
