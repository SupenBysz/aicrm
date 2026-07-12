//go:build linux

package credentialfs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

type secureDigestRoot struct {
	fd   int
	path string
	stat unix.Stat_t
}

func openSecureDigestRoot(path string) (*secureDigestRoot, error) {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, ErrInvalidPath
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return nil, ErrInvalidPath
	}
	return &secureDigestRoot{fd: fd, path: path, stat: stat}, nil
}

func (r *secureDigestRoot) Close() error { return unix.Close(r.fd) }

func (r *secureDigestRoot) DigestFile(relative string) (int64, string, error) {
	fd, err := unix.Openat2(r.fd, relative, &unix.OpenHow{
		Flags: uint64(unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW),
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS |
			unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return 0, "", ErrInvalidPath
	}
	file := os.NewFile(uintptr(fd), relative)
	if file == nil {
		_ = unix.Close(fd)
		return 0, "", ErrInvalidPath
	}
	defer file.Close()
	var before unix.Stat_t
	if err := unix.Fstat(fd, &before); err != nil ||
		before.Mode&unix.S_IFMT != unix.S_IFREG || before.Nlink != 1 {
		return 0, "", ErrInvalidPath
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return 0, "", err
	}
	var after unix.Stat_t
	if err := unix.Fstat(fd, &after); err != nil || !sameDigestStat(before, after) || size != before.Size {
		return 0, "", ErrInvalidPath
	}
	return size, hex.EncodeToString(hash.Sum(nil)), nil
}

func (r *secureDigestRoot) EnsureStable() error {
	var current, opened unix.Stat_t
	if err := unix.Lstat(r.path, &current); err != nil {
		return ErrInvalidPath
	}
	if err := unix.Fstat(r.fd, &opened); err != nil ||
		current.Mode&unix.S_IFMT != unix.S_IFDIR ||
		current.Dev != r.stat.Dev || current.Ino != r.stat.Ino ||
		opened.Dev != r.stat.Dev || opened.Ino != r.stat.Ino {
		return ErrInvalidPath
	}
	return nil
}

func sameDigestStat(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Mode == right.Mode &&
		left.Nlink == right.Nlink && left.Size == right.Size &&
		left.Mtim.Sec == right.Mtim.Sec && left.Mtim.Nsec == right.Mtim.Nsec &&
		left.Ctim.Sec == right.Ctim.Sec && left.Ctim.Nsec == right.Ctim.Nsec
}
