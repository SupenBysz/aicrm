//go:build linux

package runtimebroker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
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

const (
	credentialAnchorMode  = 0o1770
	legacyAnchorMode      = 0o1730
	maximumRuntimeEntries = 4096
	maximumRuntimeBytes   = 128 << 20
)

type credentialLockError string

func (e credentialLockError) Error() string { return string(e) }

type runtimeHomeError string

func (e runtimeHomeError) Error() string { return string(e) }

type Config struct {
	CredentialRoot   string
	RuntimeStateRoot string
	AgentUser        string
	SystemdRunPath   string
	SystemctlPath    string
	CodexBinary      string
}

type Server struct {
	cfg            Config
	brokerUID      uint32
	brokerGID      uint32
	agentUID       uint32
	agentGID       uint32
	launcher       appserver.SystemdLauncher
	commandFactory func(string, []string) *exec.Cmd
	wg             sync.WaitGroup
}

type lockedCredentialHome struct {
	server     *Server
	categoryFD int
	homeFD     int
	homePath   string
	homeName   string
	stateName  string
	statePath  string
	stateReady bool
	closed     bool
}

func New(cfg Config) (*Server, error) {
	if cfg.CredentialRoot == "" {
		cfg.CredentialRoot = "/var/lib/aicrm-agent-executors"
	}
	if cfg.RuntimeStateRoot == "" {
		cfg.RuntimeStateRoot = filepath.Join("/var/lib/private", appserver.RuntimeStateDirectory)
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
	stateRoot, err := filepath.Abs(cfg.RuntimeStateRoot)
	if err != nil || stateRoot == "/" || stateRoot == root || strings.HasPrefix(stateRoot, root+string(filepath.Separator)) {
		return nil, errors.New("invalid runtime state root")
	}
	cfg.CredentialRoot = filepath.Clean(root)
	cfg.RuntimeStateRoot = filepath.Clean(stateRoot)
	return &Server{
		cfg: cfg, brokerUID: uint32(os.Geteuid()), brokerGID: uint32(os.Getegid()), agentUID: uint32(uid), agentGID: uint32(gid),
		launcher:       appserver.SystemdLauncher{CredentialRoot: root, SystemdRunPath: cfg.SystemdRunPath, CodexBinary: cfg.CodexBinary},
		commandFactory: func(command string, args []string) *exec.Cmd { return exec.Command(command, args...) },
	}, nil
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
	lockedHome, err := s.lockCredentialHome(request.CredentialHome, request.OperationID)
	if err != nil {
		code := "credential_home_invalid"
		var lockError credentialLockError
		if errors.As(err, &lockError) {
			code = "credential_home_" + string(lockError)
		}
		s.fail(connection, code)
		return
	}
	defer lockedHome.close()
	command, args, err := s.launcher.Command(request.OperationID, request.CredentialHome)
	if err != nil {
		s.fail(connection, "launch_contract_invalid")
		return
	}
	if err := lockedHome.prepareRuntimeState(); err != nil {
		lockedHome.discardRuntimeState()
		s.fail(connection, "runtime_home_prepare_failed")
		return
	}
	cmd := s.commandFactory(command, args)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		lockedHome.discardRuntimeState()
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
	cancelled := false
	var waitErr error
	select {
	case waitErr = <-waitCh:
	case <-cancelCh:
		cancelled = true
		s.killUnit(request.OperationID)
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		waitErr = <-waitCh
	}
	if err := lockedHome.restore(); err != nil {
		code := "runtime_home_restore_failed"
		var homeError runtimeHomeError
		if errors.As(err, &homeError) {
			code = "runtime_home_" + string(homeError)
		}
		s.fail(connection, code)
		return
	}
	if waitErr != nil && !cancelled {
		s.fail(connection, "runtime_exit_failed")
		return
	}
	s.send(connection, brokerprotocol.Message{Version: brokerprotocol.Version, Type: brokerprotocol.MessageExited})
}

// lockCredentialHome walks from a broker-owned sticky root with openat2. Each
// ancestor is converted into a root-owned sticky anchor before descending, and
// the leaf is root-owned before its directory entry is rechecked. This makes a
// compromised control-plane UID unable to swap any validated component.
func (s *Server) lockCredentialHome(path, operationID string) (*lockedCredentialHome, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, credentialLockError("path_invalid")
	}
	root := filepath.Clean(s.launcher.CredentialRoot)
	relative, err := filepath.Rel(root, absolute)
	if err != nil {
		return nil, credentialLockError("path_invalid")
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) != 3 || !pathIDPattern.MatchString(parts[0]) ||
		(parts[1] != "staging" && parts[1] != "operations") || !pathIDPattern.MatchString(parts[2]) {
		return nil, credentialLockError("shape_invalid")
	}
	if !pathIDPattern.MatchString(operationID) {
		return nil, credentialLockError("operation_invalid")
	}
	rootFD, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, credentialLockError("root_open_failed")
	}
	defer unix.Close(rootFD)
	if err := s.validateCredentialRoot(rootFD); err != nil {
		return nil, credentialLockError("root_unsafe")
	}
	executorFD, err := s.anchorChild(rootFD, parts[0])
	if err != nil {
		return nil, scopedCredentialLockError("executor", err)
	}
	defer unix.Close(executorFD)
	categoryFD, err := s.anchorChild(executorFD, parts[1])
	if err != nil {
		return nil, scopedCredentialLockError("parent", err)
	}
	homeFD, err := openAnchoredDirectory(categoryFD, parts[2])
	if err != nil {
		unix.Close(categoryFD)
		return nil, credentialLockError("home_open_failed")
	}
	var homeStat unix.Stat_t
	if err := unix.Fstat(homeFD, &homeStat); err != nil || homeStat.Uid != s.agentUID || homeStat.Gid != s.agentGID || homeStat.Mode&unix.S_IFMT != unix.S_IFDIR || homeStat.Mode&0o7777 != 0o700 {
		unix.Close(homeFD)
		unix.Close(categoryFD)
		return nil, credentialLockError("home_unsafe")
	}
	if err := unix.Fchown(homeFD, int(s.brokerUID), int(s.agentGID)); err != nil {
		unix.Close(homeFD)
		unix.Close(categoryFD)
		return nil, credentialLockError("home_lock_failed")
	}
	if err := unix.Fchmod(homeFD, 0o700); err != nil {
		_ = unix.Fchown(homeFD, int(s.agentUID), int(s.agentGID))
		unix.Close(homeFD)
		unix.Close(categoryFD)
		return nil, credentialLockError("home_lock_failed")
	}
	if err := verifyDirectoryEntry(categoryFD, parts[2], &homeStat); err != nil {
		_ = unix.Fchown(homeFD, int(s.agentUID), int(s.agentGID))
		unix.Close(homeFD)
		unix.Close(categoryFD)
		return nil, credentialLockError("home_changed")
	}
	return &lockedCredentialHome{
		server: s, categoryFD: categoryFD, homeFD: homeFD, homePath: absolute, homeName: parts[2],
		stateName: operationID, statePath: filepath.Join(s.cfg.RuntimeStateRoot, operationID),
	}, nil
}

func (s *Server) validateCredentialRoot(fd int) error {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR ||
		stat.Uid != s.brokerUID || stat.Gid != s.agentGID || stat.Mode&0o7777 != credentialAnchorMode {
		return errors.New("credential root is not a broker anchor")
	}
	return nil
}

func (s *Server) anchorChild(parentFD int, name string) (int, error) {
	fd, err := openAnchoredDirectory(parentFD, name)
	if err != nil {
		switch {
		case errors.Is(err, unix.EXDEV):
			return -1, credentialLockError("open_cross_device")
		case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
			return -1, credentialLockError("open_denied")
		case errors.Is(err, unix.ELOOP):
			return -1, credentialLockError("open_symlink")
		case errors.Is(err, unix.EINVAL):
			return -1, credentialLockError("open_invalid")
		case errors.Is(err, unix.ENOENT):
			return -1, credentialLockError("open_missing")
		case errors.Is(err, unix.EAGAIN):
			return -1, credentialLockError("open_raced")
		default:
			var errno syscall.Errno
			if errors.As(err, &errno) {
				return -1, credentialLockError("open_errno_" + strconv.Itoa(int(errno)))
			}
			return -1, credentialLockError("open_failed")
		}
	}
	var before unix.Stat_t
	if err := unix.Fstat(fd, &before); err != nil || before.Mode&unix.S_IFMT != unix.S_IFDIR || before.Gid != s.agentGID {
		unix.Close(fd)
		return -1, credentialLockError("metadata_unsafe")
	}
	if before.Uid == s.agentUID {
		if before.Mode&0o7777 != 0o700 {
			unix.Close(fd)
			return -1, credentialLockError("mode_unsafe")
		}
	} else if before.Uid != s.brokerUID || (before.Mode&0o7777 != credentialAnchorMode && before.Mode&0o7777 != legacyAnchorMode) {
		unix.Close(fd)
		return -1, credentialLockError("owner_unsafe")
	}
	if err := unix.Fchown(fd, int(s.brokerUID), int(s.agentGID)); err != nil {
		unix.Close(fd)
		return -1, credentialLockError("chown_failed")
	}
	if err := unix.Fchmod(fd, credentialAnchorMode); err != nil {
		if before.Uid == s.agentUID {
			_ = unix.Fchown(fd, int(s.agentUID), int(s.agentGID))
			_ = unix.Fchmod(fd, 0o700)
		}
		unix.Close(fd)
		return -1, credentialLockError("chmod_failed")
	}
	if err := verifyDirectoryEntry(parentFD, name, &before); err != nil {
		if before.Uid == s.agentUID {
			_ = unix.Fchown(fd, int(s.agentUID), int(s.agentGID))
			_ = unix.Fchmod(fd, 0o700)
		}
		unix.Close(fd)
		return -1, credentialLockError("changed")
	}
	return fd, nil
}

func scopedCredentialLockError(scope string, err error) credentialLockError {
	var lockError credentialLockError
	if errors.As(err, &lockError) {
		return credentialLockError(scope + "_" + string(lockError))
	}
	return credentialLockError(scope + "_unsafe")
}

func openAnchoredDirectory(parentFD int, name string) (int, error) {
	if !pathIDPattern.MatchString(name) {
		return -1, errors.New("invalid directory name")
	}
	return openDirectoryEntry(parentFD, name)
}

func openDirectoryEntry(parentFD int, name string) (int, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
		return -1, errors.New("invalid directory entry")
	}
	return unix.Openat2(parentFD, name, &unix.OpenHow{
		Flags:   uint64(unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC),
		Resolve: uint64(unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV),
	})
}

func verifyDirectoryEntry(parentFD int, name string, expected *unix.Stat_t) error {
	var current unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil ||
		current.Mode&unix.S_IFMT != unix.S_IFDIR || current.Dev != expected.Dev || current.Ino != expected.Ino {
		return errors.New("directory entry changed")
	}
	return nil
}

func (h *lockedCredentialHome) prepareRuntimeState() error {
	stateRootFD, err := h.openStateRoot()
	if err != nil {
		return err
	}
	defer unix.Close(stateRootFD)
	if err := unix.Mkdirat(stateRootFD, h.stateName, 0o700); err != nil {
		return err
	}
	h.stateReady = true
	stateFD, err := openAnchoredDirectory(stateRootFD, h.stateName)
	if err != nil {
		return err
	}
	defer unix.Close(stateFD)
	limits := &treeLimits{}
	if err := copyDirectoryTree(h.homeFD, stateFD, limits); err != nil {
		return err
	}
	if err := unix.Fsync(stateFD); err != nil {
		return err
	}
	if err := unix.Fsync(stateRootFD); err != nil {
		return err
	}
	return nil
}

func (h *lockedCredentialHome) restore() error {
	if !h.stateReady {
		return nil
	}
	stateRootFD, err := h.openStateRoot()
	if err != nil {
		return runtimeHomeError("state_root_failed")
	}
	defer unix.Close(stateRootFD)
	stateFD, err := openAnchoredDirectory(stateRootFD, h.stateName)
	if err != nil {
		return runtimeHomeError("state_open_failed")
	}
	defer unix.Close(stateFD)
	returnName := ".broker-return-" + h.stateName
	if err := unix.Mkdirat(h.categoryFD, returnName, 0o700); err != nil {
		return runtimeHomeError("return_create_failed")
	}
	returnPath := filepath.Join(filepath.Dir(h.homePath), returnName)
	returnFD, err := unix.Openat(h.categoryFD, returnName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return runtimeHomeError("return_open_failed")
	}
	cleanupReturn := true
	defer func() {
		if cleanupReturn {
			_ = unix.Close(returnFD)
			_ = os.RemoveAll(returnPath)
		}
	}()
	limits := &treeLimits{}
	if err := copyDirectoryTree(stateFD, returnFD, limits); err != nil {
		return runtimeHomeError("copy_back_failed")
	}
	if err := normalizeCredentialTree(returnPath, h.server.agentUID, h.server.agentGID, false); err != nil {
		return runtimeHomeError("normalize_failed")
	}
	if err := unix.Fsync(returnFD); err != nil || unix.Fsync(h.categoryFD) != nil {
		return runtimeHomeError("return_sync_failed")
	}
	if err := unix.Renameat2(h.categoryFD, returnName, h.categoryFD, h.homeName, unix.RENAME_EXCHANGE); err != nil {
		return runtimeHomeError("rename_failed")
	}
	oldHomeFD := h.homeFD
	defer func() {
		if oldHomeFD >= 0 {
			_ = unix.Close(oldHomeFD)
		}
	}()
	h.homeFD = returnFD
	cleanupReturn = false
	if err := unix.Fchown(h.homeFD, int(h.server.agentUID), int(h.server.agentGID)); err != nil || unix.Fchmod(h.homeFD, 0o700) != nil || unix.Fsync(h.homeFD) != nil {
		return runtimeHomeError("root_normalize_failed")
	}
	if err := unix.Fsync(h.categoryFD); err != nil {
		return runtimeHomeError("category_sync_failed")
	}
	_ = unix.Close(oldHomeFD)
	oldHomeFD = -1
	// The exchanged backup still contains the control-plane-owned tree. The
	// broker deliberately runs without CAP_DAC_OVERRIDE, so normalize every
	// descendant before RemoveAll instead of relying on root bypass semantics.
	if err := makeTreeRemovable(returnPath, h.server.brokerUID, h.server.brokerGID); err != nil {
		return runtimeHomeError("old_home_normalize_failed")
	}
	if err := os.RemoveAll(returnPath); err != nil {
		return runtimeHomeError("old_home_cleanup_failed")
	}
	if err := makeTreeRemovable(h.statePath, h.server.brokerUID, h.server.brokerGID); err != nil {
		return runtimeHomeError("state_normalize_failed")
	}
	if err := os.RemoveAll(h.statePath); err != nil {
		return runtimeHomeError("state_cleanup_failed")
	}
	if err := unix.Fsync(stateRootFD); err != nil {
		return runtimeHomeError("state_sync_failed")
	}
	h.stateReady = false
	return nil
}

func (h *lockedCredentialHome) openStateRoot() (int, error) {
	fd, err := unix.Open(h.server.cfg.RuntimeStateRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR ||
		stat.Uid != h.server.brokerUID || stat.Mode&0o077 != 0 {
		unix.Close(fd)
		return -1, errors.New("runtime state root is unsafe")
	}
	return fd, nil
}

type treeLimits struct {
	entries int
	bytes   int64
}

func copyDirectoryTree(sourceFD, destinationFD int, limits *treeLimits) error {
	readerFD, err := unix.Dup(sourceFD)
	if err != nil {
		return err
	}
	reader := os.NewFile(uintptr(readerFD), "credential-source")
	entries, err := reader.ReadDir(-1)
	_ = reader.Close()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		limits.entries++
		if limits.entries > maximumRuntimeEntries {
			return errors.New("credential tree exceeds safety limits")
		}
		name := entry.Name()
		if name == "" || name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
			return errors.New("unsafe credential entry name")
		}
		var stat unix.Stat_t
		if err := unix.Fstatat(sourceFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		switch stat.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			if err := unix.Mkdirat(destinationFD, name, 0o700); err != nil {
				return err
			}
			sourceChild, err := openDirectoryEntry(sourceFD, name)
			if err != nil {
				return err
			}
			destinationChild, err := openDirectoryEntry(destinationFD, name)
			if err != nil {
				unix.Close(sourceChild)
				return err
			}
			err = copyDirectoryTree(sourceChild, destinationChild, limits)
			if err == nil {
				err = unix.Fsync(destinationChild)
			}
			unix.Close(sourceChild)
			unix.Close(destinationChild)
			if err != nil {
				return err
			}
		case unix.S_IFREG:
			limits.bytes += stat.Size
			if stat.Nlink != 1 || limits.bytes > maximumRuntimeBytes {
				return errors.New("credential tree exceeds safety limits")
			}
			if err := copyRegularFile(sourceFD, destinationFD, name); err != nil {
				return err
			}
		default:
			return errors.New("credential tree contains an unsafe entry")
		}
	}
	return unix.Fsync(destinationFD)
}

func copyRegularFile(sourceFD, destinationFD int, name string) error {
	inputFD, err := unix.Openat2(sourceFD, name, &unix.OpenHow{
		Flags:   uint64(unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC),
		Resolve: uint64(unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV),
	})
	if err != nil {
		return err
	}
	outputFD, err := unix.Openat(destinationFD, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		unix.Close(inputFD)
		return err
	}
	input := os.NewFile(uintptr(inputFD), "credential-input")
	output := os.NewFile(uintptr(outputFD), "credential-output")
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	inputCloseErr := input.Close()
	outputCloseErr := output.Close()
	for _, candidate := range []error{copyErr, syncErr, inputCloseErr, outputCloseErr} {
		if candidate != nil {
			return candidate
		}
	}
	return nil
}

func normalizeCredentialTree(root string, uid, gid uint32, includeRoot bool) error {
	directories := make([]string, 0, 16)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("runtime credential tree contains an unsafe entry")
		}
		if info.IsDir() {
			if path == root && !includeRoot {
				return nil
			}
			directories = append(directories, path)
			return nil
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Nlink != 1 {
			return errors.New("credential metadata is unsafe")
		}
		if err := os.Lchown(path, int(uid), int(gid)); err != nil {
			return err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return err
		}
		return syncPath(path)
	})
	if err != nil {
		return err
	}
	sort.Slice(directories, func(i, j int) bool { return len(directories[i]) > len(directories[j]) })
	for _, directory := range directories {
		if err := os.Lchown(directory, int(uid), int(gid)); err != nil || os.Chmod(directory, 0o700) != nil {
			return errors.New("credential directory normalization failed")
		}
		if err := syncPath(directory); err != nil {
			return err
		}
	}
	return nil
}

func syncPath(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func makeTreeRemovable(root string, uid, gid uint32) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if err := os.Lchown(path, int(uid), int(gid)); err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		mode := fs.FileMode(0o600)
		if info.IsDir() {
			mode = 0o700
		}
		return os.Chmod(path, mode)
	})
}

func (h *lockedCredentialHome) discardRuntimeState() {
	if !h.stateReady {
		return
	}
	_ = makeTreeRemovable(h.statePath, h.server.brokerUID, h.server.brokerGID)
	_ = os.RemoveAll(h.statePath)
	h.stateReady = false
}

func (h *lockedCredentialHome) close() {
	if h == nil || h.closed {
		return
	}
	h.closed = true
	_ = unix.Fchown(h.homeFD, int(h.server.agentUID), int(h.server.agentGID))
	_ = unix.Fchmod(h.homeFD, 0o700)
	_ = unix.Close(h.homeFD)
	_ = unix.Close(h.categoryFD)
}

func (s *Server) killUnit(operationID string) {
	unit := "aicrm-codex-" + operationID + ".service"
	if !unitPattern.MatchString(unit) {
		return
	}
	_ = exec.Command(s.cfg.SystemctlPath, "kill", "--kill-whom=all", "--signal=KILL", unit).Run()
	// stop waits for the unit to become inactive before credential ownership is
	// normalized and moved back to the control-plane tree.
	_ = exec.Command(s.cfg.SystemctlPath, "stop", unit).Run()
}

func (s *Server) send(connection *net.UnixConn, message brokerprotocol.Message) {
	payload, _ := json.Marshal(message)
	_, _, _ = connection.WriteMsgUnix(payload, nil, nil)
}
func (s *Server) fail(connection *net.UnixConn, code string) {
	log.Printf("runtime broker launch rejected: %s", code)
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

func CleanupStaleUnits(systemctlPath string) error {
	if systemctlPath == "" {
		systemctlPath = "/usr/bin/systemctl"
	}
	output, err := exec.Command(systemctlPath, "list-units", "--all", "--no-legend", "--plain", "aicrm-codex-*.service").Output()
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !unitPattern.MatchString(fields[0]) {
			continue
		}
		if err := exec.Command(systemctlPath, "stop", fields[0]).Run(); err != nil {
			return err
		}
	}
	return nil
}

// RecoverOrphans runs after all transient units have been stopped and before
// the broker accepts a new connection. Runtime copies were never committed, so
// they are removed; original locked homes are returned to the control-plane
// UID. An atomic-exchange backup is always the old home and is safe to remove.
func (s *Server) RecoverOrphans() error {
	if err := s.recoverRuntimeStates(); err != nil {
		return err
	}
	return s.recoverCredentialHomes()
}

func (s *Server) recoverRuntimeStates() error {
	entries, err := os.ReadDir(s.cfg.RuntimeStateRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !pathIDPattern.MatchString(entry.Name()) || entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			return errors.New("runtime state root contains an unsafe entry")
		}
		path := filepath.Join(s.cfg.RuntimeStateRoot, entry.Name())
		if err := makeTreeRemovable(path, s.brokerUID, s.brokerGID); err != nil {
			return err
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return syncPath(s.cfg.RuntimeStateRoot)
}

func (s *Server) recoverCredentialHomes() error {
	rootFD, err := unix.Open(s.cfg.CredentialRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	if err := s.validateCredentialRoot(rootFD); err != nil {
		return err
	}
	executors, err := os.ReadDir(s.cfg.CredentialRoot)
	if err != nil {
		return err
	}
	for _, executor := range executors {
		if !pathIDPattern.MatchString(executor.Name()) || executor.Type()&os.ModeSymlink != 0 || !executor.IsDir() {
			return errors.New("credential root contains an unsafe executor entry")
		}
		executorFD, err := s.anchorChild(rootFD, executor.Name())
		if err != nil {
			return err
		}
		executorPath := filepath.Join(s.cfg.CredentialRoot, executor.Name())
		for _, category := range []string{"staging", "operations"} {
			categoryPath := filepath.Join(executorPath, category)
			categoryFD, err := s.anchorChild(executorFD, category)
			var lockError credentialLockError
			if errors.As(err, &lockError) && lockError == "open_missing" {
				continue
			}
			if err != nil {
				unix.Close(executorFD)
				return err
			}
			entries, err := readDirectoryEntries(categoryFD)
			if err != nil {
				unix.Close(categoryFD)
				unix.Close(executorFD)
				return err
			}
			for _, entry := range entries {
				path := filepath.Join(categoryPath, entry.Name())
				var stat unix.Stat_t
				if err := unix.Fstatat(categoryFD, entry.Name(), &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR {
					unix.Close(categoryFD)
					unix.Close(executorFD)
					return errors.New("credential category contains an unsafe entry")
				}
				if strings.HasPrefix(entry.Name(), ".broker-return-") {
					if stat.Uid != s.brokerUID {
						unix.Close(categoryFD)
						unix.Close(executorFD)
						return errors.New("credential exchange backup owner is unsafe")
					}
					if err := makeTreeRemovable(path, s.brokerUID, s.brokerGID); err != nil || os.RemoveAll(path) != nil {
						unix.Close(categoryFD)
						unix.Close(executorFD)
						return errors.New("credential exchange backup cleanup failed")
					}
					continue
				}
				if !pathIDPattern.MatchString(entry.Name()) {
					unix.Close(categoryFD)
					unix.Close(executorFD)
					return errors.New("credential home name is unsafe")
				}
				switch stat.Uid {
				case s.agentUID:
					continue
				case s.brokerUID:
					if err := normalizeCredentialTree(path, s.agentUID, s.agentGID, true); err != nil {
						unix.Close(categoryFD)
						unix.Close(executorFD)
						return err
					}
				default:
					unix.Close(categoryFD)
					unix.Close(executorFD)
					return errors.New("credential home owner is unsafe")
				}
			}
			if err := syncPath(categoryPath); err != nil {
				unix.Close(categoryFD)
				unix.Close(executorFD)
				return err
			}
			unix.Close(categoryFD)
		}
		unix.Close(executorFD)
	}
	return syncPath(s.cfg.CredentialRoot)
}

func readDirectoryEntries(fd int) ([]os.DirEntry, error) {
	duplicate, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(duplicate), "broker-recovery-directory")
	entries, readErr := file.ReadDir(-1)
	closeErr := file.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return entries, nil
}
