package ptymanager

import "context"

type launchCLIKey struct{}

// WithLaunchCLI marks ctx with the CLI path a launch line was built for, so the terminal keeps it with the session (#391): the Windows launcher cmd is compared with the CLI the session was
// launched with, not with the setting as it is later.
func WithLaunchCLI(ctx context.Context, cli string) context.Context {
	return context.WithValue(ctx, launchCLIKey{}, cli)
}

// LaunchCLIOf is the CLI path a launch was marked with ("" when none).
func LaunchCLIOf(ctx context.Context) string {
	s, _ := ctx.Value(launchCLIKey{}).(string)
	return s
}
