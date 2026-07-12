//go:build linux

package appserver

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var operationIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)

type SystemdLauncher struct {
	SystemdRunPath string
	CodexBinary    string
	CredentialRoot string
}

type systemdProcess struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	unit      string
	systemctl string
	killOnce  sync.Once
	killErr   error
}

func (p *systemdProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *systemdProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *systemdProcess) Wait() error           { return p.cmd.Wait() }
func (p *systemdProcess) Kill() error {
	p.killOnce.Do(func() {
		// Killing systemd-run alone can leave the transient unit and its stdio
		// pipe alive. Stop the validated unit first, then reap the wrapper.
		if p.unit != "" {
			if err := exec.Command(p.systemctl, "kill", "--kill-whom=all", "--signal=KILL", p.unit).Run(); err != nil {
				p.killErr = err
			}
		}
		if p.cmd.Process != nil {
			if err := p.cmd.Process.Kill(); err != nil && p.killErr == nil {
				p.killErr = err
			}
		}
	})
	return p.killErr
}

func (l SystemdLauncher) Launch(ctx context.Context, operationID, credentialHome string) (Process, error) {
	command, args, err := l.Command(operationID, credentialHome)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, command, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	process := &systemdProcess{
		cmd: cmd, stdin: stdin, stdout: stdout,
		unit:      "aicrm-codex-" + operationID + ".service",
		systemctl: "/usr/bin/systemctl",
	}
	go func() {
		<-ctx.Done()
		_ = process.Kill()
	}()
	return process, nil
}

func (l SystemdLauncher) Command(operationID, credentialHome string) (string, []string, error) {
	if !operationIDPattern.MatchString(operationID) {
		return "", nil, errors.New("invalid operation id")
	}
	root, err := filepath.Abs(l.CredentialRoot)
	if err != nil || root == "/" {
		return "", nil, errors.New("invalid credential root")
	}
	home, err := filepath.Abs(credentialHome)
	if err != nil || home == root || !strings.HasPrefix(home, root+string(filepath.Separator)) || strings.ContainsAny(home, ":\n\r") {
		return "", nil, errors.New("credential home is outside executor root")
	}
	systemdRun := l.SystemdRunPath
	if systemdRun == "" {
		systemdRun = "/usr/bin/systemd-run"
	}
	codex := l.CodexBinary
	if codex == "" {
		codex = "/usr/bin/codex"
	}
	args := []string{
		"-i", "PATH=/usr/bin:/bin", systemdRun,
		"--system", "--pipe", "--wait", "--collect", "--quiet",
		"--unit=aicrm-codex-" + operationID,
		"--property=DynamicUser=yes",
		"--property=ProtectSystem=strict",
		"--property=ProtectHome=true",
		"--property=PrivateTmp=true",
		"--property=PrivateDevices=true",
		"--property=NoNewPrivileges=true",
		"--property=CapabilityBoundingSet=",
		"--property=UMask=0077",
		"--property=LimitCORE=0",
		"--property=KillMode=control-group",
		"--property=RuntimeMaxSec=15min",
		"--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
		"--property=BindPaths=" + home + ":/codex-home:idmap",
		"--setenv=PATH=/usr/bin:/bin",
		"--setenv=HOME=/nonexistent",
		"--setenv=CODEX_HOME=/codex-home",
		"--working-directory=/",
		codex, "app-server", "--listen", "stdio://",
	}
	return "/usr/bin/env", args, nil
}
