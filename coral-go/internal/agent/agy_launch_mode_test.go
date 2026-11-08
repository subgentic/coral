package agent

import (
	"strings"
	"testing"
)

// The mode the effective-mode display names for an agy agent is the mode the launch builder gives it: every case below is run through both (#14085).
func TestAgyLaunchModeAgreesWithTheLaunchBuilder(t *testing.T) {
	writer := &Capabilities{Allow: []string{CapFileRead, CapFileWrite, "shell:coral-board *"}}
	readOnly := &Capabilities{Allow: []string{CapFileRead}}
	full := &Capabilities{Allow: []string{CapShell, CapFileWrite}}
	for _, tc := range []struct {
		name  string
		flags []string
		caps  *Capabilities
		mode  string
		keep  bool
		want  string
	}{
		{"nothing at all", nil, nil, "", false, "default"},
		{"the Technical Writer's list under a chosen Bypass", []string{"--dangerously-skip-permissions"}, writer, "bypassPermissions", false, "accept-edits"},
		{"the same list with the Operator's choice", []string{"--dangerously-skip-permissions"}, writer, "bypassPermissions", true, "skip"},
		{"a read-only list under Bypass", nil, readOnly, "bypassPermissions", false, "plan"},
		{"a list with no explicit mode", nil, writer, "", false, "accept-edits"},
		{"full capabilities restrict nothing", nil, full, "bypassPermissions", false, "skip"},
		{"the mode alone: accept edits", nil, nil, "acceptEdits", false, "accept-edits"},
		{"the mode alone: bypass", nil, nil, "bypassPermissions", false, "skip"},
		{"the mode alone: plan", nil, nil, "plan", false, "plan"},
		{"a stored --mode", []string{"--mode", "plan"}, nil, "", false, "plan"},
		{"a stored --mode= form", []string{"--mode=accept-edits"}, nil, "", false, "accept-edits"},
		{"a stored skip switch", []string{"--dangerously-skip-permissions"}, nil, "", false, "skip"},
		{"the old --approval-mode yolo", []string{"--approval-mode", "yolo"}, nil, "", false, "skip"},
		{"the old --approval-mode=auto_edit", []string{"--approval-mode=auto_edit"}, nil, "", false, "accept-edits"},
		{"a stored flag beats the mode", []string{"--mode", "plan"}, nil, "bypassPermissions", false, "plan"},
		{"keep outranks a stored plan", []string{"--mode", "plan"}, nil, "plan", true, "skip"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := AgyLaunchMode(tc.flags, tc.caps, tc.mode, tc.keep); got != tc.want {
				t.Errorf("AgyLaunchMode = %q, want %q", got, tc.want)
			}
			cmd := buildLaunch(&AgyAgent{}, LaunchParams{Flags: tc.flags, Capabilities: tc.caps, PermissionMode: tc.mode, KeepFullAccess: tc.keep})
			built := "default"
			switch {
			case strings.Contains(cmd, "--dangerously-skip-permissions"):
				built = "skip"
			case strings.Contains(cmd, "--mode accept-edits"), strings.Contains(cmd, "--mode=accept-edits"):
				built = "accept-edits"
			case strings.Contains(cmd, "--mode plan"), strings.Contains(cmd, "--mode=plan"):
				built = "plan"
			}
			if built != tc.want {
				t.Errorf("the launch builder gives %q, the table says %q: %q", built, tc.want, cmd)
			}
		})
	}
}
