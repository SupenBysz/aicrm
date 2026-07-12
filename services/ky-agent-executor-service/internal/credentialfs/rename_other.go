//go:build !linux

package credentialfs

import "errors"

func renameNoReplace(string, string) error {
	return errors.New("no-replace credential promotion requires Linux")
}
