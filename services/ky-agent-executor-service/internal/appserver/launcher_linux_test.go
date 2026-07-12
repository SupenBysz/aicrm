//go:build linux

package appserver

import (
	"strings"
	"testing"
)

func TestSystemdCommandIsStdioOnlyAndEnvironmentIsCleared(t *testing.T) {
	launcher := SystemdLauncher{
		CredentialRoot: "/var/lib/aicrm-agent-executors",
		CodexBinary:    "/usr/bin/codex",
	}
	command, args, err := launcher.Command("operation_1", "/var/lib/aicrm-agent-executors/executor_1/operations/operation_1/home")
	if err != nil {
		t.Fatal(err)
	}
	joined := command + " " + strings.Join(args, " ")
	for _, required := range []string{
		"/usr/bin/env -i", "DynamicUser=yes", "ProtectSystem=strict", "ProtectHome=true",
		"PrivateDevices=true", "NoNewPrivileges=true", "CapabilityBoundingSet=", "UMask=0077",
		"KillMode=control-group", "CODEX_HOME=/codex-home", "app-server --listen stdio://",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %q in %s", required, joined)
		}
	}
	for _, forbidden := range []string{"ws://", "unix://", "codex --remote", "pty", "DATABASE_URL", "INTERNAL_TOKEN", "API_KEY", "ACCESS_TOKEN"} {
		if strings.Contains(strings.ToUpper(joined), strings.ToUpper(forbidden)) {
			t.Fatalf("forbidden %q in %s", forbidden, joined)
		}
	}
}

func TestSystemdCommandRejectsPathAndOperationInjection(t *testing.T) {
	launcher := SystemdLauncher{CredentialRoot: "/var/lib/aicrm-agent-executors"}
	for _, test := range []struct{ operation, home string }{
		{"../operation", "/var/lib/aicrm-agent-executors/executor/home"},
		{"operation", "/etc"},
		{"operation", "/var/lib/aicrm-agent-executors/escape:target"},
	} {
		if _, _, err := launcher.Command(test.operation, test.home); err == nil {
			t.Fatalf("accepted operation=%q home=%q", test.operation, test.home)
		}
	}
}
