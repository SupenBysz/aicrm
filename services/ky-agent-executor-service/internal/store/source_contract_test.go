package store

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestProductionStoreContainsOnlyReadQueries(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate store source")
	}
	sourcePath := filepath.Join(filepath.Dir(file), "store.go")
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	upper := strings.ToUpper(string(source))
	for _, forbidden := range []string{"INSERT INTO", "UPDATE KY_", "DELETE FROM", "TRUNCATE ", "COPY KY_"} {
		if strings.Contains(upper, forbidden) {
			t.Fatalf("P1 store contains forbidden write token %q", forbidden)
		}
	}
	for _, forbiddenProjection := range []string{
		"auth_account_label", "bound_device_id", "capabilities",
		"codex_thread_id", "result_summary", "error_message",
		"raw_text", "raw_json", "terminal_line",
	} {
		if strings.Contains(string(source), forbiddenProjection) {
			t.Fatalf("P1 store selects forbidden legacy/raw field %q", forbiddenProjection)
		}
	}
}

func TestProductionTreeOnlyAllowsIsolatedStdioAppServerLauncher(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate service tree")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(source)
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if strings.Contains(text, `"os/exec"`) || strings.Contains(text, "exec.Command") {
			allowed := map[string]bool{
				"internal/appserver/launcher_linux.go":   true,
				"internal/runtimebroker/server_linux.go": true,
			}
			if !allowed[filepath.ToSlash(relative)] {
				t.Fatalf("process spawning escaped isolated launcher: %s", path)
			}
		}
		for _, forbidden := range []string{"codex --remote", "--listen ws", "--listen unix", `"github.com/creack/pty"`, "CODEX_HOME="} {
			if strings.Contains(strings.ToLower(text), strings.ToLower(forbidden)) && filepath.ToSlash(relative) != "internal/appserver/launcher_linux.go" {
				t.Fatalf("production file %s contains runtime token %q", path, forbidden)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	launcher, err := os.ReadFile(filepath.Join(root, "internal", "appserver", "launcher_linux.go"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(launcher)
	for _, required := range []string{
		`"/usr/bin/env"`, `"-i"`, "systemd-run", "DynamicUser=yes", "ProtectSystem=strict",
		"PrivateDevices=true", "CapabilityBoundingSet=", `"app-server", "--listen", "stdio://"`,
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("isolated launcher is missing %q", required)
		}
	}
	broker, err := os.ReadFile(filepath.Join(root, "internal", "runtimebroker", "server_linux.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"SO_PEERCRED", "agentUID", "ReadMsgUnix", "receivedFDs", "validateCredentialHome", "lockCredentialHome", "Openat", "Fchown"} {
		if !strings.Contains(string(broker), required) {
			t.Fatalf("runtime broker is missing %q", required)
		}
	}
}
