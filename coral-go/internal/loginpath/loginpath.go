// Package loginpath gives a Coral that was not started from a shell the PATH its user's shell has (#15072).
//
// A Coral started from Finder, a launcher, a login item or a service gets the system's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin on a Mac), with none of what the user's profile exports: Homebrew's folder,
// ~/.local/bin, nvm's node. Everything Coral itself runs then misses the user's tools: a workflow step, a hook, the gh that reads a pull request's status, an agent CLI in a folder the common places do not list.
// Widen asks the user's login shell once, early, for its PATH and appends the folders the process does not already have: never first, never reordered, so what was on the PATH still wins.
package loginpath

import (
	"strings"
)

const (
	beginMark = "__CORAL_LOGIN_PATH_BEGIN__"
	endMark   = "__CORAL_LOGIN_PATH_END__"
	// maxPath caps what is read from a shell: a PATH longer than this is not one.
	maxPath = 16 << 10
)

// parse is the PATH a shell printed between the marks, whatever else its startup files wrote around it. "" when the marks are not there.
func parse(out string) string {
	i := strings.LastIndex(out, beginMark)
	if i < 0 {
		return ""
	}
	rest := out[i+len(beginMark):]
	j := strings.Index(rest, endMark)
	if j < 0 {
		return ""
	}
	p := rest[:j]
	if len(p) > maxPath {
		return ""
	}
	return p
}

// Merge is current with the folders of login it does not have appended, in login's order. A folder that is not an absolute path, an empty entry, a control character and a repeat are left out:
// what a shell printed is data, and only a folder name is taken from it. added is how many folders were appended.
func Merge(current, login string, sep string) (merged string, added int) {
	have := map[string]bool{}
	for _, e := range strings.Split(current, sep) {
		have[e] = true
	}
	out := current
	for _, e := range strings.Split(login, sep) {
		if e == "" || have[e] || !strings.HasPrefix(e, "/") || strings.ContainsAny(e, "\x00\r\n\t") {
			continue
		}
		have[e] = true
		if out != "" {
			out += sep
		}
		out += e
		added++
	}
	return out, added
}
