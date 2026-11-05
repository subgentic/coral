// Package coral holds the one file of the module's root that programs embed: the protocol every team agent is given (#13523).
package coral

import _ "embed"

// Protocol is PROTOCOL.md, the Coral agent protocol, compiled into the program: a release build has no source tree and no file next to the executable, so reading it from disk gave every agent nothing (#13523).
// An embedded text cannot be replaced by a file an agent writes, which is why #3601 stopped reading it from the home folder.
//
//go:embed PROTOCOL.md
var Protocol string
