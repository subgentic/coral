package agent

import (
	"strings"
	"testing"
)

// #15727: the reason beside New agent's flags line. It speaks only when the flags that run differ from the mode's own, and it agrees with what LaunchCommand types.
func TestCodexModeNoteSaysWhyTheFlagsAreNotTheModes(t *testing.T) {
	narrow := &Capabilities{Allow: []string{"shell"}, Deny: []string{"git_write"}}
	wide := &Capabilities{Allow: []string{"shell"}}
	readOnly := &Capabilities{Allow: []string{"file_read"}}
	for _, tc := range []struct {
		name string
		caps *Capabilities
		mode string
		keep bool
		want string // a phrase the note holds; "" for no note
	}{
		{"Bypass, no capabilities", nil, "bypassPermissions", false, ""},
		{"Plan, no capabilities", nil, "plan", false, ""},
		{"Default, no capabilities: Auto's own flags, nothing narrows them (#21335)", nil, "default", false, ""},
		{"Bypass narrowed by Shell with limits", narrow, "bypassPermissions", false, "narrow this mode to workspace writes, asks first"},
		{"Auto with Shell with limits: the limits no longer make it ask, so nothing differs from the mode (#21335)", narrow, "auto", false, ""},
		{"Auto narrowed to read-only by file_read", readOnly, "auto", false, "narrow this mode to read-only"},
		{"Plan with Shell with limits stays Plan", narrow, "plan", false, ""},
		{"Bypass with Shell, no limits stands", wide, "bypassPermissions", false, ""},
		{"Default with Shell, no limits runs Auto's pair, which is the mode (#21335)", wide, "default", false, ""},
		{"Default with Shell with limits is still Auto's pair (#21335)", narrow, "default", false, ""},
		{"Default with file_read: Auto narrowed to read-only (#21335)", readOnly, "default", false, "Default is Auto for Codex, and the agent's capabilities narrow it to read-only"},
		{"Full access kept, whatever the capabilities say", narrow, "plan", true, "Full access is kept"},
	} {
		got := CodexModeNote(tc.caps, tc.mode, tc.keep)
		if tc.want == "" && got != "" || tc.want != "" && !strings.Contains(got, tc.want) {
			t.Errorf("%s: note %q, want it to hold %q", tc.name, got, tc.want)
		}
	}
}
