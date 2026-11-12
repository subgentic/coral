package agent

import (
	"strings"
	"testing"
)

// #15727: the reason beside New agent's flags line. It speaks only when the flags that run differ from the mode's own, and it agrees with what LaunchCommand types.
func TestCodexModeNoteSaysWhyTheFlagsAreNotTheModes(t *testing.T) {
	narrow := &Capabilities{Allow: []string{"shell"}, Deny: []string{"git_write"}}
	wide := &Capabilities{Allow: []string{"shell"}}
	for _, tc := range []struct {
		name string
		caps *Capabilities
		mode string
		keep bool
		want string // a phrase the note holds; "" for no note
	}{
		{"Bypass, no capabilities", nil, "bypassPermissions", false, ""},
		{"Plan, no capabilities", nil, "plan", false, ""},
		{"Default, no capabilities: Codex's own config decides", nil, "default", false, ""},
		{"Bypass narrowed by Shell with limits", narrow, "bypassPermissions", false, "narrow this mode to workspace writes, asks first"},
		{"Auto narrowed by Shell with limits", narrow, "auto", false, "narrow this mode to workspace writes, asks first"},
		{"Plan with Shell with limits stays Plan", narrow, "plan", false, ""},
		{"Bypass with Shell, no limits stands", wide, "bypassPermissions", false, ""},
		{"Default with Shell, no limits runs Auto's pair", wide, "default", false, "capabilities set them: workspace writes, never asks"},
		{"Default with Shell with limits", narrow, "default", false, "capabilities set them: workspace writes, asks first"},
		{"Full access kept, whatever the capabilities say", narrow, "plan", true, "Full access is kept"},
	} {
		got := CodexModeNote(tc.caps, tc.mode, tc.keep)
		if tc.want == "" && got != "" || tc.want != "" && !strings.Contains(got, tc.want) {
			t.Errorf("%s: note %q, want it to hold %q", tc.name, got, tc.want)
		}
	}
}
