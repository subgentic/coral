package agent

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// LaunchPermissionArgs is the permission part of the command line a launch with these params would run (#15719): the arguments Coral adds for the mode, Full access and the capabilities, read
// off the real LaunchCommand, so the New agent dialog's line can never say one thing and the launch another. A launch is built for a throwaway session id; the temp files that build writes
// (the prompt, the settings) are removed again. Only permission arguments are kept; the agent's other arguments (its prompt, hooks, model) are not the question.
func LaunchPermissionArgs(agentType string, params LaunchParams) ([]string, error) {
	if agentType == at.Pi || agentType == at.Terminal {
		return nil, nil // Pi has no permission system; a plain shell has no agent
	}
	params = previewParams(agentType, params)
	// Hermes builds its command by preparing a home folder under the data dir and writing its first message there: a preview writes nothing, and what Hermes adds for permissions is only the
	// --yolo its Flags carry, so that is read straight off the flags (the same ones the launch is given).
	if agentType == at.Hermes {
		return permissionArgsOf(params.Flags), nil
	}
	id := newPreviewSessionID() // its own id per call: two previews at once never delete each other's files
	params.SessionID = id
	defer removePreviewFiles(id)
	cmd, err := GetAgent(agentType).LaunchCommand(params)
	if err != nil {
		return nil, err
	}
	return permissionArgsOf(splitShellWords(cmd)), nil
}

// newPreviewSessionID is a random version-4 id for one preview.
func newPreviewSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// removePreviewFiles deletes what LaunchCommand wrote for this preview's id: files, and agy's hooks folder with what is in it.
func removePreviewFiles(id string) {
	found, _ := filepath.Glob(filepath.Join(LaunchTempDir(), "coral_*_"+id+"_*"))
	for _, f := range found {
		_ = os.RemoveAll(f)
	}
}

// permissionArgsOf keeps the arguments that set what an agent may do without asking: the flags each CLI has for its mode, with their values, and Codex's network switch for its workspace sandbox.
func permissionArgsOf(words []string) []string {
	var out []string
	for i := 0; i < len(words); i++ {
		w := words[i]
		switch w {
		case "--permission-mode", "--mode", "--sandbox", "-s", "-a", "--ask-for-approval", "--approval-mode":
			out = append(out, w)
			if i+1 < len(words) {
				out = append(out, words[i+1])
				i++
			}
		case "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--approve-for-me":
			out = append(out, w)
		case "-c", "--config":
			if i+1 < len(words) && strings.HasPrefix(words[i+1], "sandbox_workspace_write.") {
				out = append(out, w, words[i+1])
			}
			i++ // a config value is never a flag
		}
	}
	return out
}

// splitShellWords splits a launch line into words the way the shell reads it: spaces separate, single and double quotes group (a backslash inside double quotes escapes the next character). It does not
// run anything: $( ... ) stays text.
func splitShellWords(s string) []string {
	var words []string
	var cur strings.Builder
	in, started := rune(0), false
	flush := func() {
		if started {
			words = append(words, cur.String())
			cur.Reset()
			started = false
		}
	}
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case in == '\'':
			if c == '\'' {
				in = 0
			} else {
				cur.WriteRune(c)
			}
		case in == '"':
			switch {
			case c == '"':
				in = 0
			case c == '\\' && i+1 < len(rs):
				i++
				cur.WriteRune(rs[i])
			default:
				cur.WriteRune(c)
			}
		case c == '\'' || c == '"':
			in, started = c, true
		case c == ' ' || c == '\t' || c == '\n' || c == ';':
			flush()
		default:
			cur.WriteRune(c)
			started = true
		}
	}
	flush()
	return words
}
