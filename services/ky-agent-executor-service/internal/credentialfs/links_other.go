//go:build !linux

package credentialfs

import "os"

// The server credential runtime is Linux-only. Other targets retain the
// portable digest implementation for tooling, while their platform-specific
// bridge must enforce the same no-hardlink rule before producing a proof.
func regularFileHasMultipleLinks(os.FileInfo) bool { return false }
