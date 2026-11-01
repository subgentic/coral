//go:build !windows

package agent

import (
	"fmt"
	"strings"
)

// hermesToolTrusted says whether the hook tool at path may be named in Hermes's config: Hermes runs a hook even when its script changed after approval (the mtime in its allowlist is advisory only, #11715), so the
// tool, and every folder and link on the way to it, must be changeable by nobody but the user and root (secfile's walk, as for the node a launch runs: another owner, a group or other write bit, any doubt or error
// refuses). This guards against a mistake (a tool folder left writable), not against an agent that chooses to rewrite its own home: it runs as the same user and can edit what the user owns.
func hermesToolTrusted(path string) error {
	who, err := pathWriters(path)
	if err != nil {
		return fmt.Errorf("it could not be checked: %w", err)
	}
	if len(who) > 0 {
		text := make([]string, len(who))
		for i, w := range who {
			text[i] = w.Text
		}
		return fmt.Errorf("it can be changed by others: %s", strings.Join(text, "; "))
	}
	return nil
}
