package agent

import (
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
	// The launch route takes a mode as the CLI's own flags (only "default" is a mode there, #10362): the line is built from the same flags the dashboard sends for the mode.
	if own, _ := SplitPermissionFlags(params.Flags); len(own) == 0 && params.PermissionMode != "" && params.PermissionMode != "default" {
		params.Flags = append(append([]string{}, params.Flags...), PermissionFlagsForAgent(agentType, params.PermissionMode)...)
		params.PermissionMode = "default"
	}
	params.SessionID, params.PermissionPreview = previewSessionID, true
	params.ResumeSessionID = ""
	if params.WorkingDir == "" {
		params.WorkingDir = os.TempDir()
	}
	defer removePreviewFiles()
	cmd, err := GetAgent(agentType).LaunchCommand(params)
	if err != nil {
		return nil, err
	}
	return permissionArgsOf(splitShellWords(cmd)), nil
}

const previewSessionID = "00000000-0000-4000-8000-000000000000"

// removePreviewFiles deletes what LaunchCommand wrote for previewSessionID.
func removePreviewFiles() {
	found, _ := filepath.Glob(filepath.Join(LaunchTempDir(), "coral_*_"+previewSessionID+"_*"))
	for _, f := range found {
		_ = os.Remove(f)
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
		case "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto":
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
