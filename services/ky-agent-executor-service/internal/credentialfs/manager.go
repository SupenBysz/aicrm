package credentialfs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var (
	ErrInvalidPath    = errors.New("invalid executor credential path")
	ErrDigestMismatch = errors.New("credential binding digest mismatch")
	ErrTargetExists   = errors.New("credential revision target already exists")
	safeIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)
)

type Manager struct {
	root string
}

func New(root string) (*Manager, error) {
	absolute, err := filepath.Abs(root)
	if err != nil || absolute == string(filepath.Separator) {
		return nil, ErrInvalidPath
	}
	if info, err := os.Lstat(absolute); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrInvalidPath
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return &Manager{root: filepath.Clean(absolute)}, nil
}

func (m *Manager) Root() string { return m.root }

func (m *Manager) StagingPath(executorID, sessionID string) (string, error) {
	return m.scoped(executorID, "staging", sessionID)
}

func (m *Manager) RevisionPath(executorID string, revision int64) (string, error) {
	if revision < 1 {
		return "", ErrInvalidPath
	}
	return m.scoped(executorID, "revisions", strconv.FormatInt(revision, 10))
}

func (m *Manager) OperationPath(executorID, operationID string) (string, error) {
	return m.scoped(executorID, "operations", operationID)
}

func (m *Manager) QuarantinePath(executorID, name string) (string, error) {
	return m.scoped(executorID, "quarantine", name)
}

func (m *Manager) CreateStaging(executorID, sessionID string) (string, error) {
	path, err := m.StagingPath(executorID, sessionID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return "", ErrTargetExists
		}
		return "", err
	}
	return path, nil
}

func (m *Manager) CloneRevision(executorID string, revision int64, operationID string) (string, error) {
	source, err := m.RevisionPath(executorID, revision)
	if err != nil {
		return "", err
	}
	target, err := m.OperationPath(executorID, operationID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return "", ErrTargetExists
		}
		return "", err
	}
	if err := copyTree(source, target); err != nil {
		_ = os.RemoveAll(target)
		return "", err
	}
	return target, nil
}

func (m *Manager) Promote(executorID, sessionID string, revision int64, expectedDigest string) (string, error) {
	if !isDigest(expectedDigest) {
		return "", ErrDigestMismatch
	}
	staging, err := m.StagingPath(executorID, sessionID)
	if err != nil {
		return "", err
	}
	target, err := m.RevisionPath(executorID, revision)
	if err != nil {
		return "", err
	}
	digest, err := DigestTree(staging)
	if err != nil {
		return "", err
	}
	if digest != expectedDigest {
		return "", ErrDigestMismatch
	}
	if err := DurableBarrier(staging); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := renameNoReplace(staging, target); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return "", ErrTargetExists
		}
		return "", err
	}
	if err := makeReadOnly(target); err != nil {
		return "", err
	}
	if err := DurableBarrier(target); err != nil {
		return "", err
	}
	if err := syncDirectory(filepath.Dir(target)); err != nil {
		return "", err
	}
	verified, err := DigestTree(target)
	if err != nil {
		return "", err
	}
	if verified != expectedDigest {
		return "", ErrDigestMismatch
	}
	return target, nil
}

func (m *Manager) Quarantine(executorID, sourcePath, name string) (string, error) {
	if err := m.ensureContained(sourcePath); err != nil {
		return "", err
	}
	target, err := m.QuarantinePath(executorID, name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := renameNoReplace(sourcePath, target); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return "", ErrTargetExists
		}
		return "", err
	}
	if err := DurableBarrier(target); err != nil {
		return "", err
	}
	if err := syncDirectory(filepath.Dir(target)); err != nil {
		return "", err
	}
	return target, nil
}

func (m *Manager) RemoveEphemeral(path string) error {
	if err := m.ensureContained(path); err != nil {
		return err
	}
	relative, err := filepath.Rel(m.root, path)
	if err != nil {
		return ErrInvalidPath
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) < 3 || (parts[1] != "staging" && parts[1] != "operations" && parts[1] != "quarantine") {
		return ErrInvalidPath
	}
	return os.RemoveAll(path)
}

func (m *Manager) scoped(executorID, category, id string) (string, error) {
	if !safeIDPattern.MatchString(executorID) || !safeIDPattern.MatchString(id) {
		return "", ErrInvalidPath
	}
	path := filepath.Join(m.root, executorID, category, id)
	if err := m.ensureContained(path); err != nil {
		return "", err
	}
	return path, nil
}

func (m *Manager) ensureContained(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil || absolute == m.root || !strings.HasPrefix(filepath.Clean(absolute), m.root+string(filepath.Separator)) {
		return ErrInvalidPath
	}
	return nil
}

func DigestTree(root string) (string, error) {
	root = filepath.Clean(root)
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", ErrInvalidPath
	}
	type entry struct {
		raw    string
		rel    string
		size   int64
		digest string
	}
	entries := make([]entry, 0, 32)
	normalizedPaths := make(map[string]struct{}, 32)
	var totalSize int64
	reader, err := openSecureDigestRoot(root)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	err = filepath.WalkDir(root, func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		metadata, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if metadata.Mode()&os.ModeSymlink != 0 || (!metadata.IsDir() && !metadata.Mode().IsRegular()) {
			return ErrInvalidPath
		}
		if metadata.IsDir() {
			return nil
		}
		if regularFileHasMultipleLinks(metadata) {
			return ErrInvalidPath
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return ErrInvalidPath
		}
		rawRelative := filepath.ToSlash(relative)
		if !utf8.ValidString(rawRelative) {
			return ErrInvalidPath
		}
		relative = norm.NFC.String(rawRelative)
		if relative == "" || strings.HasPrefix(relative, "/") {
			return ErrInvalidPath
		}
		for _, segment := range strings.Split(relative, "/") {
			if segment == "" || segment == "." || segment == ".." {
				return ErrInvalidPath
			}
		}
		if _, exists := normalizedPaths[relative]; exists {
			return ErrInvalidPath
		}
		normalizedPaths[relative] = struct{}{}
		size, fileDigest, err := reader.DigestFile(rawRelative)
		if err != nil {
			return err
		}
		if size != metadata.Size() || size < 0 || size > 9_007_199_254_740_991 {
			return ErrInvalidPath
		}
		totalSize += size
		if len(entries) >= 4096 || totalSize > 128<<20 {
			return ErrInvalidPath
		}
		entries = append(entries, entry{
			raw: rawRelative, rel: relative, size: size, digest: fileDigest,
		})
		return nil
	})
	if err != nil {
		return "", err
	}
	if err := reader.EnsureStable(); err != nil {
		return "", err
	}
	observedPaths, err := collectDigestFilePaths(root)
	if err != nil || len(observedPaths) != len(entries) {
		return "", ErrInvalidPath
	}
	expectedPaths := make([]string, 0, len(entries))
	for _, item := range entries {
		expectedPaths = append(expectedPaths, item.raw)
	}
	sort.Strings(expectedPaths)
	for index := range observedPaths {
		if observedPaths[index] != expectedPaths[index] {
			return "", ErrInvalidPath
		}
	}
	for _, item := range entries {
		size, digest, err := reader.DigestFile(item.raw)
		if err != nil || size != item.size || digest != item.digest {
			return "", ErrInvalidPath
		}
	}
	if err := reader.EnsureStable(); err != nil {
		return "", err
	}
	sort.Slice(entries, func(i, j int) bool {
		return bytes.Compare([]byte(entries[i].rel), []byte(entries[j].rel)) < 0
	})
	// RFC 8785 canonical JSON sorts these ASCII object keys as path, sha256,
	// size. Paths are already NFC UTF-8 and sizes are safe non-negative
	// integers, so the specialized writer below covers the full manifest shape.
	var canonical bytes.Buffer
	canonical.WriteByte('[')
	for index, item := range entries {
		if index > 0 {
			canonical.WriteByte(',')
		}
		canonical.WriteString(`{"path":`)
		appendJCSString(&canonical, item.rel)
		canonical.WriteString(`,"sha256":"`)
		canonical.WriteString(item.digest)
		canonical.WriteString(`","size":`)
		canonical.WriteString(strconv.FormatInt(item.size, 10))
		canonical.WriteByte('}')
	}
	canonical.WriteByte(']')
	treeHash := sha256.Sum256(canonical.Bytes())
	return hex.EncodeToString(treeHash[:]), nil
}

func collectDigestFilePaths(root string) ([]string, error) {
	paths := make([]string, 0, 32)
	err := filepath.WalkDir(root, func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		metadata, err := os.Lstat(path)
		if err != nil || metadata.Mode()&os.ModeSymlink != 0 ||
			(!metadata.IsDir() && !metadata.Mode().IsRegular()) {
			return ErrInvalidPath
		}
		if metadata.IsDir() {
			return nil
		}
		if regularFileHasMultipleLinks(metadata) {
			return ErrInvalidPath
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return ErrInvalidPath
		}
		relative = filepath.ToSlash(relative)
		if !utf8.ValidString(relative) {
			return ErrInvalidPath
		}
		for _, segment := range strings.Split(relative, "/") {
			if segment == "" || segment == "." || segment == ".." {
				return ErrInvalidPath
			}
		}
		paths = append(paths, relative)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	return paths, nil
}

func appendJCSString(target *bytes.Buffer, value string) {
	const lowerHex = "0123456789abcdef"
	target.WriteByte('"')
	for _, char := range value {
		switch char {
		case '"':
			target.WriteString(`\"`)
		case '\\':
			target.WriteString(`\\`)
		case '\b':
			target.WriteString(`\b`)
		case '\t':
			target.WriteString(`\t`)
		case '\n':
			target.WriteString(`\n`)
		case '\f':
			target.WriteString(`\f`)
		case '\r':
			target.WriteString(`\r`)
		default:
			if char < 0x20 {
				target.WriteString(`\u00`)
				target.WriteByte(lowerHex[byte(char)>>4])
				target.WriteByte(lowerHex[byte(char)&0x0f])
				continue
			}
			target.WriteRune(char)
		}
	}
	target.WriteByte('"')
}

func DurableBarrier(root string) error {
	directories := make([]string, 0, 16)
	err := filepath.WalkDir(root, func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		metadata, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if metadata.Mode()&os.ModeSymlink != 0 || (!metadata.IsDir() && !metadata.Mode().IsRegular()) {
			return ErrInvalidPath
		}
		if metadata.IsDir() {
			directories = append(directories, path)
			return nil
		}
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
	})
	if err != nil {
		return err
	}
	sort.Slice(directories, func(i, j int) bool { return len(directories[i]) > len(directories[j]) })
	for _, directory := range directories {
		if err := syncDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

func ValidateReadOnlyTree(root string) error {
	root = filepath.Clean(root)
	return filepath.WalkDir(root, func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		metadata, err := os.Lstat(path)
		if err != nil || metadata.Mode()&os.ModeSymlink != 0 ||
			(!metadata.IsDir() && !metadata.Mode().IsRegular()) || metadata.Mode().Perm()&0o222 != 0 {
			return ErrInvalidPath
		}
		if metadata.Mode().IsRegular() && regularFileHasMultipleLinks(metadata) {
			return ErrInvalidPath
		}
		return nil
	})
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == source {
			return nil
		}
		metadata, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if metadata.Mode()&os.ModeSymlink != 0 || (!metadata.IsDir() && !metadata.Mode().IsRegular()) {
			return ErrInvalidPath
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || strings.HasPrefix(relative, "..") {
			return ErrInvalidPath
		}
		destination := filepath.Join(target, relative)
		if metadata.IsDir() {
			return os.Mkdir(destination, 0o700)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			_ = input.Close()
			return err
		}
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
	})
}

func makeReadOnly(root string) error {
	paths := make([]string, 0, 32)
	if err := filepath.WalkDir(root, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		paths = append(paths, path)
		return nil
	}); err != nil {
		return err
	}
	sort.Slice(paths, func(i, j int) bool { return len(paths[i]) > len(paths[j]) })
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return ErrInvalidPath
		}
		mode := fs.FileMode(0o400)
		if info.IsDir() {
			mode = 0o500
		}
		if err := os.Chmod(path, mode); err != nil {
			return fmt.Errorf("make credential revision read-only: %w", err)
		}
	}
	return nil
}

func isDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && strings.ToLower(value) == value
}
