//go:build !windows

// coral-heavy-run is the wrapper that runs on the mini under a restricted account (#13719 step 2, #13750): the account's key is "restrict,command=<this>", so this is all that key can run. It reads everything from stdin
// (a header, then a tar of the worktree) and NEVER looks at its arguments or at SSH_ORIGINAL_COMMAND: the stream is hostile input and this program is the boundary. See internal/heavy.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/subgentic/coral/internal/heavy"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil || home == "" || !filepath.IsAbs(home) {
		fmt.Fprintf(os.Stderr, "%srefused: no home folder\n", heavy.Trailer)
		os.Exit(heavy.ExitRefused)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	defer stop()
	code := heavy.Serve(ctx, os.Stdin, os.Stdout, os.Stderr, heavy.Config{Root: filepath.Join(home, "coral-test"), Home: home, WatchStdin: true})
	stop()
	os.Exit(code)
}
