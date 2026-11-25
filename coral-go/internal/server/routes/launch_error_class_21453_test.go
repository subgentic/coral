package routes

import (
	"errors"
	"fmt"
	"testing"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/tracking"
)

// #21453: an "internal" launch failure carries a fixed class; the class is never the error's text.
func TestLaunchErrorClass(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{errLaunchSettings, tracking.ClassSettingsUnreadable},
		{fmt.Errorf("wrapped: %w", &agent.CLIUntrustedMountError{AgentType: "claude", Binary: "claude", Dir: "/mnt/secret-folder"}), tracking.ClassCLIUntrustedMount},
		{agent.ErrRealGeminiCLI, tracking.ClassCLIWrongBinary},
		{errors.New("/home/someone/bin/claude is not executable"), tracking.ClassCLIPathInvalid},
		{errors.New(`model "x" belongs to openai provider and cannot launch with claude agent`), tracking.ClassModelMismatch},
		{errors.New("the agent's environment is empty: refusing to start it with Coral's own"), tracking.ClassEnvEmpty},
		{errors.New("can't write the step's system text file: open /tmp/x: no space left on device"), tracking.ClassLaunchFiles},
		{errors.New("something no one expected"), tracking.ClassOther},
	}
	for _, c := range cases {
		if got := launchErrorClass(c.err); got != c.want {
			t.Errorf("%v: class %q, want %q", c.err, got, c.want)
		}
	}
	if launchErrorClass(nil) != "" {
		t.Error("nil error has a class")
	}
}
