package routes

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11399: auto-accept judges the WHOLE command. The pending tool the chat shows is cut at 4,000 bytes, so a harmful part after the cut used to be unseen and the request allowed; a request that cannot be
// read whole (longer than Coral keeps, not text, hiding characters) is never auto-accepted, and a clean one still is.
func TestAutoAcceptReadsTheWholeCommandAndRefusesWhatItCannotRead(t *testing.T) {
	for name, tc := range map[string]struct {
		input    map[string]any
		accepted bool
	}{
		"a clean command of 400 bytes":                   {map[string]any{"command": "echo " + strings.Repeat("x", 395)}, true},
		"a clean command of 600 bytes":                   {map[string]any{"command": "echo " + strings.Repeat("x", 595)}, true},
		"a risky tail after the 4,000 byte cut":          {map[string]any{"command": "echo " + strings.Repeat("x", 4100) + "; rm -rf ~"}, false},
		"the same tail at 600 bytes is seen too":         {map[string]any{"command": "echo " + strings.Repeat("x", 600) + "; rm -rf ~"}, false},
		"a clean command longer than the cut":            {map[string]any{"command": "echo " + strings.Repeat("x", 4100)}, true},
		"a command longer than auto-accept reads":        {map[string]any{"command": "echo " + strings.Repeat("x", riskMaxBytes+10)}, false},
		"a right-to-left override":                       {map[string]any{"command": "echo ok ‮"}, false},
		"a zero-width space":                             {map[string]any{"command": "echo o​k"}, false},
		"a tail after a run of blanks":                   {map[string]any{"command": "echo ok" + strings.Repeat(" ", 3000) + "true"}, false},
		"a command that is not text":                     {map[string]any{"command": []any{"echo", "ok"}}, false},
		"a path with a hidden character":                 {map[string]any{"file_path": "notes‮.txt"}, false},
		"a clean path":                                   {map[string]any{"file_path": "notes.txt"}, true},
		"a Windows line end (CR then LF) is a newline":   {map[string]any{"command": "echo ok\r\necho more\r\n"}, true},
		"a lone CR hides what it overwrote":              {map[string]any{"command": "echo safe\rrm -rf ~"}, false},
		"a CR at the very end is alone":                  {map[string]any{"command": "echo ok\r"}, false},
		"a newline and a tab are plain text":             {map[string]any{"command": "echo ok\n\techo more"}, true},
		"Windsurf's CommandLine with a hidden character": {map[string]any{"CommandLine": "echo ok‮"}, false},
	} {
		t.Run(name, func(t *testing.T) {
			r := newAutoAcceptRig(t)
			sid := r.agent(at.Claude, "dev", autoAcceptScreen(t, "claude_bash"))
			r.enable("dev", sid)
			tool := "Bash"
			if _, ok := tc.input["file_path"]; ok {
				tool = "Edit"
			}
			r.h.pending.set(sid, newPendingTool("tu1", tool, tc.input, r.now))
			r.notify("dev", sid, "Notification: Claude needs your permission to use "+tool)
			r.run()
			if tc.accepted {
				assert.Equal(t, []string{"1"}, r.keys(at.Claude, sid), "a request it can read whole and that holds nothing risky is answered")
			} else {
				assert.Empty(t, r.keys(at.Claude, sid), "nothing is typed: the request is the person's to answer")
				assert.Empty(t, r.events(sid, "auto_accept"))
			}
		})
	}
}

func TestPendingRiskKeepsTheWholeTextAndSaysWhyWhenItCannot(t *testing.T) {
	long := "echo " + strings.Repeat("x", 5000)
	p := newPendingTool("t", "Bash", map[string]any{"command": long}, time.Now())
	assert.Equal(t, long, p.Risk["command"], "the whole text is kept for the risk rules")
	assert.Less(t, len(p.Input["command"].(string)), len(long), "the chat's copy is still cut")
	assert.Empty(t, p.Unjudged)
	p = newPendingTool("t", "Bash", map[string]any{"command": "ok‮"}, time.Now())
	assert.Contains(t, p.Unjudged, "hide what it does")
}
