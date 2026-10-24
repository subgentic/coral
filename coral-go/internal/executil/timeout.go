package executil

import (
	"context"
	"time"
)

// Output runs name with args and returns its standard output, killing it after d. The helper
// programs Coral asks for system facts (ps, tmux, osascript) can hang: a stuck ps used to block
// the loop that called it for good, so none of those calls runs without a deadline (#3999, the
// #3994 audit finding 4).
func Output(d time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return Command(ctx, name, args...).Output() // Windows: no console window, and the whole tree ends at the deadline (#349)
}

// Run runs name with args and waits for it, killing it after d.
func Run(d time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return Command(ctx, name, args...).Run()
}
