//go:build windows

package sshprov

import "errors"

// ensurePrivateDir: Windows OpenSSH has no ControlMaster, so sharing is never on there.
func ensurePrivateDir(string) error { return errors.New("sshprov: no connection sharing on Windows") }
