//go:build linux

package appserver

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

var operationIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)

const RuntimeStateDirectory = "aicrm-codex-runtime"

type SystemdLauncher struct {
	SystemdRunPath string
	CodexBinary    string
	CredentialRoot string
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
	runtimeHome := filepath.Join("/var/lib", RuntimeStateDirectory, operationID)
	args := []string{
		"-i", "PATH=/usr/bin:/bin", systemdRun,
		"--system", "--pipe", "--wait", "--collect", "--quiet",
		"--unit=aicrm-codex-" + operationID,
		"--property=DynamicUser=yes",
		"--property=ProtectSystem=strict",
		"--property=ProtectHome=true",
		"--property=PrivateTmp=true",
		"--property=PrivateDevices=true",
		"--property=PrivateMounts=true",
		"--property=NoNewPrivileges=true",
		"--property=CapabilityBoundingSet=",
		"--property=UMask=0077",
		"--property=LimitCORE=0",
		"--property=KillMode=control-group",
		"--property=RuntimeMaxSec=15min",
		"--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
		"--property=RestrictNamespaces=true",
		"--property=RestrictSUIDSGID=true",
		"--property=LockPersonality=true",
		"--property=ProtectClock=true",
		"--property=ProtectControlGroups=true",
		"--property=ProtectKernelLogs=true",
		"--property=ProtectKernelModules=true",
		"--property=ProtectKernelTunables=true",
		"--property=ProtectHostname=true",
		"--property=ProtectProc=invisible",
		"--property=ProcSubset=pid",
		"--property=SystemCallArchitectures=native",
		"--property=StateDirectory=" + RuntimeStateDirectory + "/" + operationID,
		"--property=StateDirectoryMode=0700",
		"--property=InaccessiblePaths=-" + root + " -/data/kyai_crm/config",
		"--setenv=PATH=/usr/bin:/bin",
		"--setenv=HOME=/nonexistent",
		"--setenv=CODEX_HOME=" + runtimeHome,
		"--working-directory=/",
		codex, "app-server", "--listen", "stdio://",
	}
	return "/usr/bin/env", args, nil
}
