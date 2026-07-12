package credentialfs

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPromotionIsDigestBoundNoReplaceAndReadOnly(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("server promotion is Linux-only")
	}
	manager, err := New(filepath.Join(t.TempDir(), "executors"))
	if err != nil {
		t.Fatal(err)
	}
	staging, err := manager.CreateStaging("executor_1", "session_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(staging, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "auth.json"), []byte(`{"safe":"credential-bytes"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "nested", "config.toml"), []byte("model = 'gpt-5.6'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := DigestTree(staging)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Promote("executor_1", "session_1", 1, "0000000000000000000000000000000000000000000000000000000000000000"); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("expected digest mismatch, got %v", err)
	}
	target, err := manager.Promote("executor_1", "session_1", 1, digest)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := DigestTree(target)
	if err != nil || verified != digest {
		t.Fatalf("verified=%s err=%v", verified, err)
	}
	info, err := os.Stat(filepath.Join(target, "auth.json"))
	if err != nil || info.Mode().Perm() != 0o400 {
		t.Fatalf("credential file mode=%v err=%v", info.Mode().Perm(), err)
	}

	second, err := manager.CreateStaging("executor_1", "session_2")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "auth.json"), []byte(`{"other":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	secondDigest, _ := DigestTree(second)
	if _, err := manager.Promote("executor_1", "session_2", 1, secondDigest); !errors.Is(err, ErrTargetExists) {
		t.Fatalf("expected no-replace target error, got %v", err)
	}
}

func TestCloneIsWritableCOWAndDoesNotMutateRevision(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("server promotion is Linux-only")
	}
	manager, _ := New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := manager.CreateStaging("executor_1", "session_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	digest, _ := DigestTree(staging)
	revision, err := manager.Promote("executor_1", "session_1", 1, digest)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := manager.CloneRevision("executor_1", 1, "operation_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(operation, "auth.json"), []byte("rotated"), 0o600); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(filepath.Join(revision, "auth.json"))
	if string(original) != "original" {
		t.Fatalf("active revision was mutated: %q", original)
	}
	if err := manager.RemoveEphemeral(revision); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("active revision removal should be rejected, got %v", err)
	}
	if err := manager.RemoveEphemeral(operation); err != nil {
		t.Fatal(err)
	}
}

func TestPathsRejectTraversalSymlinksAndArbitraryDeletion(t *testing.T) {
	manager, _ := New(filepath.Join(t.TempDir(), "executors"))
	for _, value := range []string{"../escape", "with/slash", "", "with:colon"} {
		if _, err := manager.StagingPath(value, "session"); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("executor id %q accepted: %v", value, err)
		}
		if _, err := manager.StagingPath("executor", value); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("session id %q accepted: %v", value, err)
		}
	}
	root, _ := manager.CreateStaging("executor", "session")
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := DigestTree(root); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("symlink digest should fail closed, got %v", err)
	}
	if err := manager.RemoveEphemeral("/tmp"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("arbitrary delete accepted: %v", err)
	}
}
