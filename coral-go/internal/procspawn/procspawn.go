// Package procspawn starts a process that macOS does not count as part of Coral (#12836).
//
// macOS attributes every process to a "responsible" one, inherited down the process tree: a tmux server or a guardian that Coral starts is attributed to Coral.app (its
// coral-tray). When a GUI program that is also attributed to Coral.app exits, loginwindow force-quits everything attributed to it ("scheduling its subordinates'
// termination"): the tmux server on Coral's socket, every agent in it, caffeinate, node and Chrome (00:37 on 2026-11-03: a webview test run from an agent shell).
// A process spawned with the disclaim flag is its own responsible process, so it is no part of that group. Only darwin has the notion; elsewhere Supported is false
// and the caller starts the process as it always did.
package procspawn

import (
	"errors"
	"os"
)

// ErrUnsupported is returned by Spawn where the platform has no such thing.
var ErrUnsupported = errors.New("procspawn: not supported on this platform")

// Options say how a process is started.
type Options struct {
	Env    []string
	Stdin  *os.File // nil: /dev/null
	Stdout *os.File // nil: /dev/null
	Stderr *os.File // nil: /dev/null
	Setsid bool     // in a session of its own
}
