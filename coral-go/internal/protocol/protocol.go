// Package protocol holds the Coral agent protocol, compiled into the program (#13523).
package protocol

import _ "embed"

// Text is PROTOCOL.md, the Coral agent protocol: a release build has no source tree and no file next to the executable, so reading it from disk gave every agent nothing (#13523).
// An embedded text cannot be replaced by a file an agent writes, which is why #3601 stopped reading it from the home folder.
// It lives here, not at the module root, because a Go package at the root breaks the CI shard script.
//
//go:embed PROTOCOL.md
var Text string
