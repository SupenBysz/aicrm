//go:build linux

package runtimebroker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/brokerprotocol"
	"golang.org/x/sys/unix"
)

var unitPattern = regexp.MustCompile(`^aicrm-codex-[A-Za-z0-9_-]{1,120}\.service$`)
var pathIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)

type Config struct {
	CredentialRoot string
	AgentUser      string
	SystemdRunPath string
	SystemctlPath  string
	CodexBinary    string
}

type Server struct {
	cfg            Config
	agentUID       uint32
	agentGID       uint32
	launcher       appserver.SystemdLauncher
	commandFactory func(string, []string) *exec.Cmd
	wg             sync.WaitGroup
}

func New(cfg Config) (*Server, error) {
	if cfg.CredentialRoot == "" {
		cfg.CredentialRoot = "/var/lib/aicrm-agent-executors"
	}
	if cfg.AgentUser == "" {
		cfg.AgentUser = "ky-agent-executor"
	}
	if cfg.SystemctlPath == "" {
		cfg.SystemctlPath = "/usr/bin/systemctl"
	}
	account, err := user.Lookup(cfg.AgentUser)
	if err != nil {
		return nil, err
	}
	uid, err := strconv.ParseUint(account.Uid, 10, 32)
	if err != nil {
		return nil, err
	}
	gid, err := strconv.ParseUint(account.Gid, 10, 32)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(cfg.CredentialRoot)
	if err != nil || root == "/" {
		return nil, errors.New("invalid credential root")
	}
	return &Server{cfg: cfg, agentUID: uint32(uid), agentGID: uint32(gid), launcher: appserver.SystemdLauncher{CredentialRoot: root, SystemdRunPath: cfg.SystemdRunPath, CodexBinary: cfg.CodexBinary}, commandFactory: func(command string, args []string) *exec.Cmd { return exec.Command(command, args...) }}, nil
}

func (s *Server) Serve(ctx context.Context, listener *net.UnixListener) error {
	if listener == nil {
		return errors.New("runtime broker listener is required")
	}
	go func() { <-ctx.Done(); _ = listener.Close() }()
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			return err
		}
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.handle(connection) }()
	}
	s.wg.Wait()
	return nil
}

func (s *Server) handle(connection *net.UnixConn) {
	defer connection.Close()
	uid, err := peerUID(connection)
	if err != nil || uid != s.agentUID {
		s.fail(connection, "peer_unauthorized")
		return
	}
	buffer := make([]byte, brokerprotocol.MaximumBytes)
	oob := make([]byte, unix.CmsgSpace(2*4))
	n, oobn, flags, _, err := connection.ReadMsgUnix(buffer, oob)
	if err != nil || flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 {
		s.fail(connection, "invalid_request")
		return
	}
	var request brokerprotocol.Message
	if json.Unmarshal(buffer[:n], &request) != nil || request.Version != brokerprotocol.Version || request.Type != brokerprotocol.MessageLaunch {
		s.fail(connection, "invalid_request")
		return
	}
	fds, err := receivedFDs(oob[:oobn])
	if err != nil || len(fds) != 2 {
		s.fail(connection, "invalid_file_descriptors")
		closeFDs(fds)
		return
	}
	stdin := os.NewFile(uintptr(fds[0]), "runtime-stdin")
	stdout := os.NewFile(uintptr(fds[1]), "runtime-stdout")
	defer stdin.Close()
	defer stdout.Close()
	unlockHome, err := s.lockCredentialHome(request.CredentialHome)
	if err != nil {
		s.fail(connection, "credential_home_invalid")
		return
	}
	defer unlockHome()
	command, args, err := s.launcher.Command(request.OperationID, request.CredentialHome)
	if err != nil {
		s.fail(connection, "launch_contract_invalid")
		return
	}
	cmd := s.commandFactory(command, args)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		s.fail(connection, "runtime_start_failed")
		return
	}
	s.send(connection, brokerprotocol.Message{Version: brokerprotocol.Version, Type: brokerprotocol.MessageStarted})
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()
	cancelCh := make(chan struct{}, 1)
	go func() {
		control := make([]byte, brokerprotocol.MaximumBytes)
		n, _, _, _, err := connection.ReadMsgUnix(control, nil)
		if err != nil {
			cancelCh <- struct{}{}
			return
		}
		var message brokerprotocol.Message
		if json.Unmarshal(control[:n], &message) == nil && message.Version == brokerprotocol.Version && message.Type == brokerprotocol.MessageCancel {
			cancelCh <- struct{}{}
		}
	}()
	select {
	case <-waitCh:
	case <-cancelCh:
		s.killUnit(request.OperationID)
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-waitCh
	}
	s.send(connection, brokerprotocol.Message{Version: brokerprotocol.Version, Type: brokerprotocol.MessageExited})
}

func (s *Server) validateCredentialHome(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	root := filepath.Clean(s.launcher.CredentialRoot)
	if absolute == root || !strings.HasPrefix(filepath.Clean(absolute), root+string(filepath.Separator)) {
		return errors.New("outside credential root")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil || resolved != filepath.Clean(absolute) {
		return errors.New("symlink path")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return errors.New("credential home is not a directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != s.agentUID {
		return errors.New("credential home owner mismatch")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("credential home permissions are too broad")
	}
	return nil
}

// lockCredentialHome makes the category parent root-owned for the exact
// lifetime of the transient unit. This closes the validate/use rename race:
// the Agent UID cannot replace the validated home after the second openat.
func (s *Server) lockCredentialHome(path string) (func(), error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	root := filepath.Clean(s.launcher.CredentialRoot)
	relative, err := filepath.Rel(root, absolute)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) != 3 || !pathIDPattern.MatchString(parts[0]) ||
		(parts[1] != "staging" && parts[1] != "operations") || !pathIDPattern.MatchString(parts[2]) {
		return nil, errors.New("credential home shape is invalid")
	}
	parentPath := filepath.Join(root, parts[0], parts[1])
	parent, err := os.Open(parentPath)
	if err != nil {
		return nil, err
	}
	locked := false
	unlock := func() {
		if locked {
			_ = unix.Fchown(int(parent.Fd()), int(s.agentUID), int(s.agentGID))
			_ = unix.Fchmod(int(parent.Fd()), 0o700)
		}
		_ = parent.Close()
	}
	var parentStat unix.Stat_t
	if err := unix.Fstat(int(parent.Fd()), &parentStat); err != nil || parentStat.Uid != s.agentUID || parentStat.Gid != s.agentGID || parentStat.Mode&unix.S_IFMT != unix.S_IFDIR || parentStat.Mode&0o077 != 0 {
		unlock()
		return nil, errors.New("credential parent is unsafe")
	}
	if err := unix.Fchown(int(parent.Fd()), 0, 0); err != nil {
		unlock()
		return nil, err
	}
	locked = true
	if err := unix.Fchmod(int(parent.Fd()), 0o700); err != nil {
		unlock()
		return nil, err
	}
	homeFD, err := unix.Openat(int(parent.Fd()), parts[2], unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		unlock()
		return nil, err
	}
	defer unix.Close(homeFD)
	var homeStat unix.Stat_t
	if err := unix.Fstat(homeFD, &homeStat); err != nil || homeStat.Uid != s.agentUID || homeStat.Gid != s.agentGID || homeStat.Mode&unix.S_IFMT != unix.S_IFDIR || homeStat.Mode&0o077 != 0 {
		unlock()
		return nil, errors.New("credential home changed during lock")
	}
	return unlock, nil
}

func (s *Server) killUnit(operationID string) {
	unit := "aicrm-codex-" + operationID + ".service"
	if !unitPattern.MatchString(unit) {
		return
	}
	_ = exec.Command(s.cfg.SystemctlPath, "kill", "--kill-whom=all", "--signal=KILL", unit).Run()
}

func (s *Server) send(connection *net.UnixConn, message brokerprotocol.Message) {
	payload, _ := json.Marshal(message)
	_, _, _ = connection.WriteMsgUnix(payload, nil, nil)
}
func (s *Server) fail(connection *net.UnixConn, code string) {
	s.send(connection, brokerprotocol.Message{Version: brokerprotocol.Version, Type: brokerprotocol.MessageFailed, FailureCode: code})
}

func peerUID(connection *net.UnixConn) (uint32, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return 0, err
	}
	var credential *unix.Ucred
	var controlErr error
	err = raw.Control(func(fd uintptr) {
		credential, controlErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if err != nil {
		return 0, err
	}
	if controlErr != nil {
		return 0, controlErr
	}
	if credential == nil {
		return 0, errors.New("missing peer credential")
	}
	return credential.Uid, nil
}

func receivedFDs(oob []byte) ([]int, error) {
	messages, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil, err
	}
	fds := []int{}
	for _, message := range messages {
		rights, err := unix.ParseUnixRights(&message)
		if err != nil {
			closeFDs(fds)
			return nil, err
		}
		fds = append(fds, rights...)
	}
	return fds, nil
}
func closeFDs(fds []int) {
	for _, fd := range fds {
		_ = unix.Close(fd)
	}
}

func ListenerFromSystemd() (*net.UnixListener, error) {
	pid, err := strconv.Atoi(os.Getenv("LISTEN_PID"))
	if err != nil || pid != os.Getpid() || os.Getenv("LISTEN_FDS") != "1" {
		return nil, errors.New("exactly one systemd socket is required")
	}
	file := os.NewFile(uintptr(3), "runtime-broker-listener")
	if file == nil {
		return nil, errors.New("systemd socket fd is unavailable")
	}
	listener, err := net.FileListener(file)
	_ = file.Close()
	if err != nil {
		return nil, err
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		_ = listener.Close()
		return nil, errors.New("systemd socket is not unix")
	}
	return unixListener, nil
}

func CleanupStaleUnits(systemctlPath string) {
	if systemctlPath == "" {
		systemctlPath = "/usr/bin/systemctl"
	}
	output, err := exec.Command(systemctlPath, "list-units", "--all", "--no-legend", "--plain", "aicrm-codex-*.service").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !unitPattern.MatchString(fields[0]) {
			continue
		}
		_ = exec.Command(systemctlPath, "stop", fields[0]).Run()
	}
}
