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

func TestProductionTreeHasNoProcessSpawner(t *testing.T) {
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
		for _, forbidden := range []string{`"os/exec"`, "exec.Command", "codex app-server", "CODEX_HOME"} {
			if strings.Contains(text, forbidden) {
				t.Fatalf("production file %s contains process/runtime token %q", path, forbidden)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
