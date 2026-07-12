//go:build !linux

package credentialfs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
)

type secureDigestRoot struct {
	path string
	info os.FileInfo
}

func openSecureDigestRoot(path string) (*secureDigestRoot, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrInvalidPath
	}
	return &secureDigestRoot{path: path, info: info}, nil
}

func (r *secureDigestRoot) Close() error { return nil }

func (r *secureDigestRoot) DigestFile(relative string) (int64, string, error) {
	path := filepath.Join(r.path, filepath.FromSlash(relative))
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || regularFileHasMultipleLinks(before) {
		return 0, "", ErrInvalidPath
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	hash := sha256.New()
	size, copyErr := io.Copy(hash, file)
	after, statErr := file.Stat()
	closeErr := file.Close()
	if copyErr != nil {
		return 0, "", copyErr
	}
	if statErr != nil || closeErr != nil || !os.SameFile(before, after) || size != before.Size() || before.ModTime() != after.ModTime() {
		return 0, "", ErrInvalidPath
	}
	return size, hex.EncodeToString(hash.Sum(nil)), nil
}

func (r *secureDigestRoot) EnsureStable() error {
	current, err := os.Lstat(r.path)
	if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(r.info, current) {
		return ErrInvalidPath
	}
	return nil
}
