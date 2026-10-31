package executil

import (
	"context"
	"os/exec"
	"path/filepath"

	"github.com/subgentic/coral/internal/lookpath"
)

// command is exec.CommandContext, except that a bare program name is looked up through lookpath (remembered) and the program is started by the path it found: the standard library would
// look the name up in every PATH folder for every extension at every call (git runs many times a minute), and under 'go test' each of those stats is a cache-check cost (#413). Args[0] stays
// the name the caller gave. A name that is not found, or is not a bare name, goes to exec.CommandContext as before, with its own error.
func command(ctx context.Context, name string, args ...string) *exec.Cmd {
	if lookpath.IsBare(name) {
		if p, err := lookpath.Path(name); err == nil && filepath.IsAbs(p) {
			cmd := exec.CommandContext(ctx, p, args...)
			cmd.Args[0] = name
			return cmd
		}
	}
	return exec.CommandContext(ctx, name, args...)
}
