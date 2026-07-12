package credentialfs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
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
	if err := ValidateReadOnlyTree(target); err != nil {
		t.Fatalf("promoted revision is not read-only: %v", err)
	}
	if err := os.Chmod(filepath.Join(target, "auth.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReadOnlyTree(target); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("writable revision accepted: %v", err)
	}
	if err := os.Chmod(filepath.Join(target, "auth.json"), 0o400); err != nil {
		t.Fatal(err)
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

func TestOperationPromotionCreatesANewImmutableRevision(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("server promotion is Linux-only")
	}
	manager, _ := New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := manager.CreateStaging("executor_1", "session_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	digest, _ := DigestTree(staging)
	original, err := manager.Promote("executor_1", "session_1", 1, digest)
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
	rotatedDigest, err := DigestTree(operation)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := manager.PromoteOperation("executor_1", "operation_1", 2, rotatedDigest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(operation); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("operation source survived promotion: %v", err)
	}
	if err := ValidateReadOnlyTree(rotated); err != nil {
		t.Fatalf("rotated revision is not immutable: %v", err)
	}
	originalBytes, _ := os.ReadFile(filepath.Join(original, "auth.json"))
	rotatedBytes, _ := os.ReadFile(filepath.Join(rotated, "auth.json"))
	if string(originalBytes) != "original" || string(rotatedBytes) != "rotated" {
		t.Fatalf("original=%q rotated=%q", originalBytes, rotatedBytes)
	}
}

func TestImmutableRevisionCanBeQuarantinedWithoutRemainingWritable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("server quarantine is Linux-only")
	}
	manager, _ := New(filepath.Join(t.TempDir(), "executors"))
	staging, _ := manager.CreateStaging("executor_1", "session_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("credential"), 0o600)
	digest, _ := DigestTree(staging)
	revision, err := manager.Promote("executor_1", "session_1", 1, digest)
	if err != nil {
		t.Fatal(err)
	}
	quarantined, err := manager.Quarantine("executor_1", revision, "revision_1_failed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(revision); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("revision source survived quarantine: %v", err)
	}
	if err := ValidateReadOnlyTree(quarantined); err != nil {
		t.Fatalf("quarantined revision became writable: %v", err)
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

func TestDigestTreeMatchesLockedCanonicalJSONVector(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "目录"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "目录", "é.txt"), []byte{0x00, 0xff, 'A', 'i', 'C', 'R', 'M'}, 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := DigestTree(root)
	if err != nil {
		t.Fatal(err)
	}
	const expected = "49d15c1f078a22e6a917007dd4c8957bdb47f4cd6b205d7004db5145e2922743"
	if digest != expected {
		t.Fatalf("digest=%s expected=%s", digest, expected)
	}
	if err := os.Chmod(filepath.Join(root, "a.txt"), 0o400); err != nil {
		t.Fatal(err)
	}
	changedTime := time.Unix(1_700_000_000, 0)
	if err := os.Chtimes(filepath.Join(root, "a.txt"), changedTime, changedTime); err != nil {
		t.Fatal(err)
	}
	afterMetadataChange, err := DigestTree(root)
	if err != nil || afterMetadataChange != expected {
		t.Fatalf("metadata changed digest=%s err=%v", afterMetadataChange, err)
	}
}

func TestDigestTreeNormalizesNFCAndRejectsNormalizedCollisions(t *testing.T) {
	composedRoot := t.TempDir()
	decomposedRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(composedRoot, "é.txt"), []byte("same"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(decomposedRoot, "e\u0301.txt"), []byte("same"), 0o600); err != nil {
		t.Fatal(err)
	}
	composed, err := DigestTree(composedRoot)
	if err != nil {
		t.Fatal(err)
	}
	decomposed, err := DigestTree(decomposedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if composed != decomposed {
		t.Fatalf("NFC-equivalent paths diverged: %s != %s", composed, decomposed)
	}
	collisionRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(collisionRoot, "é.txt"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(collisionRoot, "e\u0301.txt"), []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := DigestTree(collisionRoot); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("normalized collision err=%v", err)
	}
}

func TestDigestTreeRejectsHardlinksAndSpecialFiles(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("server credential filesystem is Linux-only")
	}
	hardlinkRoot := t.TempDir()
	original := filepath.Join(hardlinkRoot, "auth.json")
	if err := os.WriteFile(original, []byte("credential"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(original, filepath.Join(hardlinkRoot, "alias.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := DigestTree(hardlinkRoot); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("hardlink digest err=%v", err)
	}

	fifoRoot := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(fifoRoot, "credential.pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := DigestTree(fifoRoot); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("FIFO digest err=%v", err)
	}
}

func TestDigestTreeEmptyDirectoriesDoNotChangeCanonicalFileList(t *testing.T) {
	root := t.TempDir()
	digest, err := DigestTree(root)
	if err != nil {
		t.Fatal(err)
	}
	const emptyDigest = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
	if digest != emptyDigest {
		t.Fatalf("empty digest=%s", digest)
	}
	if err := os.MkdirAll(filepath.Join(root, "empty", "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	withDirectories, err := DigestTree(root)
	if err != nil || withDirectories != emptyDigest {
		t.Fatalf("empty directories changed digest=%s err=%v", withDirectories, err)
	}
}

func TestDigestTreeUsesJCSStringEscaping(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "ampersand<&>.txt"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "unicode"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "unicode", "line\u2028separator.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := DigestTree(root)
	if err != nil {
		t.Fatal(err)
	}
	const expected = "4f19a416ea7b40e89cd21a6dd508c850578c1daa6be50b9c3aa0e7eb2ee6a890"
	if digest != expected {
		t.Fatalf("JCS edge digest=%s expected=%s", digest, expected)
	}
}

func TestDigestTreeAllowsFilenameBeginningWithTwoDots(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "..profile"), []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := DigestTree(root); err != nil {
		t.Fatalf("legal filename was rejected: %v", err)
	}
}

func TestExecutorLockSerializesCredentialOperations(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("server credential filesystem is Linux-only")
	}
	manager, err := New(filepath.Join(t.TempDir(), "executors"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.AcquireExecutorLock(context.Background(), "executor_1")
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan *ExecutorLock, 1)
	errorsCh := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		lock, err := manager.AcquireExecutorLock(ctx, "executor_1")
		if err != nil {
			errorsCh <- err
			return
		}
		acquired <- lock
	}()
	select {
	case lock := <-acquired:
		_ = lock.Close()
		t.Fatal("second operation acquired the executor lock concurrently")
	case err := <-errorsCh:
		t.Fatalf("second lock failed early: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case lock := <-acquired:
		if err := lock.Close(); err != nil {
			t.Fatal(err)
		}
	case err := <-errorsCh:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal("second operation did not acquire the released lock")
	}
}
