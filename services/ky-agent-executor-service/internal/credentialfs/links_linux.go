//go:build linux

package credentialfs

import (
	"os"
	"syscall"
)

func regularFileHasMultipleLinks(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return !ok || stat.Nlink != 1
}
