package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestLegacyExecutorMutationEndpointsAreGoneBeforeDecode(t *testing.T) {
	for _, path := range []string{
		"/api/v1/ai-executor-tasks",
		"/api/v1/ai-executor-runs",
		"/api/v1/ai-executor-runs/run_1/terminal-resize",
		"/api/v1/ai-executor-runs/run_1/interrupt",
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPost,
				path,
				strings.NewReader(`not-json codexHome=/root/.codex rawError=must-not-be-decoded`),
			)
			rec := httptest.NewRecorder()

			switch path {
			case "/api/v1/ai-executor-tasks":
				(&Server{}).createExecutorTask(rec, req, wsContext{})
			case "/api/v1/ai-executor-runs":
				(&Server{}).createExecutorRun(rec, req, wsContext{})
			case "/api/v1/ai-executor-runs/run_1/terminal-resize":
				(&Server{}).resizeExecutorTerminal(rec, req, wsContext{})
			case "/api/v1/ai-executor-runs/run_1/interrupt":
				(&Server{}).interruptExecutorRun(rec, req, wsContext{})
			}

			if rec.Code != http.StatusGone {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusGone)
			}
			assertLegacyAuthorizationHeaders(t, rec)
			assertErrorCode(t, rec.Body.String(), "legacy_endpoint_gone")
			for _, forbidden := range []string{"codexHome", "CODEX_HOME", "/root/.codex", "rawError", "must-not-be-decoded"} {
				if strings.Contains(rec.Body.String(), forbidden) {
					t.Fatalf("response contains forbidden request material %q: %s", forbidden, rec.Body.String())
				}
			}
		})
	}
}

func TestServerStartupDoesNotLaunchLegacyExecutorWorker(t *testing.T) {
	body, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatalf("read server.go: %v", err)
	}
	for _, forbidden := range []string{
		"go s.runExecutorWorker(ctx)",
		"s.runExecutorWorker(ctx)",
		"executeCodexTUIRun(",
		"CODEX_HOME",
		"DisableLegacyExecutorRuntime",
	} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("server startup source contains retired runtime hook %q", forbidden)
		}
	}
	if !strings.Contains(string(body), "legacy TUI/PTY/WebSocket executor worker is permanently retired") {
		t.Fatal("server startup is missing the legacy worker retirement guard")
	}
}

func TestLegacyExecutorSpawnChainStaysQuarantined(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read server package: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		if name == "executor_worker.go" || name == "executor_tui.go" {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, forbidden := range []string{
			"runExecutorWorker(",
			"executeCodexTask(",
			"executeCodexTUIRun(",
			"CODEX_HOME",
			"exec.Command",
		} {
			if strings.Contains(string(body), forbidden) {
				t.Fatalf("retired executor spawn chain escaped quarantine into %s: %q", name, forbidden)
			}
		}
	}
}
