package agent

import (
	"os"
	"regexp"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// LaunchCommandPreview is the command a launch with these params would start the agent with (#15951), for the dialogs that show it before Launch: the agent's program and its arguments,
// read off the real LaunchCommand (the same builder, so the line can never say one thing and the launch another), with everything Coral makes up for the session replaced by a placeholder
// (RedactLaunchCommand). The environment Coral sets in front of the program is left out. Nothing is run or kept: a launch is built for a throwaway session id and the temp files that
// build writes are removed again.
func LaunchCommandPreview(agentType string, params LaunchParams) (string, error) {
	if agentType == at.Terminal {
		return "", nil // a plain shell has no agent command
	}
	params = previewParams(agentType, params)
	if agentType == at.Opencode { // its server is started by a real launch: the preview names the address and the password file it would use
		params.OpencodeURL, params.OpencodePasswordFile = "<opencode-server-url>", "<opencode-password-file>"
	}
	id := newPreviewSessionID()
	params.SessionID = id
	defer removePreviewFiles(id)
	cmd, err := GetAgent(agentType).LaunchCommand(params)
	if err != nil {
		return "", err
	}
	return RedactLaunchCommand(cmd, id), nil
}

// previewParams is what a preview builds from: the mode turned into the CLI's own flags the way the launch route does, a throwaway session, no resume.
func previewParams(agentType string, params LaunchParams) LaunchParams {
	if own, _ := SplitPermissionFlags(params.Flags); len(own) == 0 && params.PermissionMode != "" && params.PermissionMode != "default" {
		params.Flags = append(append([]string{}, params.Flags...), PermissionFlagsForAgent(agentType, params.PermissionMode)...)
		params.PermissionMode = "default"
	}
	params.PermissionPreview = true
	params.ResumeSessionID = ""
	if params.WorkingDir == "" {
		params.WorkingDir = os.TempDir()
	}
	return params
}

var (
	reCatFile   = regexp.MustCompile(`"?\$\(cat '[^']*'\)"?`)
	reHookTool  = regexp.MustCompile(`[^\s"'\\]*coral-hook-[A-Za-z0-9_-]+(?:\.exe)?`)
	reSecretish = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}|\b[A-Fa-f0-9]{32,}\b`)
)

// RedactLaunchCommand keeps the part of a launch line a person can act on and hides what is Coral's own: the environment in front of the program is dropped (the last top-level `;` or `&&`
// starts the program), the session id, the files and folders Coral writes for the session (settings, prompts, hooks, the Pi extension) and its hook tools become <placeholders>, a prompt Coral
// reads from a file is <coral-text>, and anything shaped like a key or a token is <redacted>. What the person chose (the model, the mode's flags, their own flags) is shown as it runs.
func RedactLaunchCommand(cmd, sessionID string) string {
	tail := strings.TrimSpace(cmd[lastTopLevelSeparator(cmd):])
	tail = reCatFile.ReplaceAllString(tail, "<coral-text>")
	if sessionID != "" {
		tail = regexp.MustCompile(`[^\s'"=]*`+regexp.QuoteMeta(sessionID)+`[^\s'"]*`).ReplaceAllStringFunc(tail, func(m string) string {
			if m == sessionID {
				return "<session-id>"
			}
			if strings.HasPrefix(m, "--") || !strings.Contains(m, "/") && !strings.Contains(m, `\`) && !strings.Contains(m, "coral_") {
				return strings.ReplaceAll(m, sessionID, "<session-id>")
			}
			return "<coral-file>"
		})
	}
	tail = reHookTool.ReplaceAllString(tail, "<coral-hook>")
	return reSecretish.ReplaceAllString(tail, "<redacted>")
}

// lastTopLevelSeparator is the offset just after the last `;` or `&&` that is not inside quotes or a $( ): where the program of a launch line starts.
func lastTopLevelSeparator(s string) int {
	last, depth := 0, 0
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case q == '\'':
			if c == '\'' {
				q = 0
			}
		case q == '"':
			switch {
			case c == '\\':
				i++
			case c == '"':
				q = 0
			case c == '$' && i+1 < len(s) && s[i+1] == '(':
				depth++
				i++
			case c == ')' && depth > 0:
				depth--
			}
		case c == '\'' || c == '"':
			q = c
		case c == '\\':
			i++
		case c == ';' || c == '&' && i+1 < len(s) && s[i+1] == '&':
			if c == '&' {
				i++
			}
			last = i + 1
		}
	}
	return last
}

// RedactTokenShapes hides anything shaped like a key or a token in a sentence (an error text shown beside a preview, #16052), the same shapes RedactLaunchCommand hides in a command.
func RedactTokenShapes(s string) string { return reSecretish.ReplaceAllString(s, "<redacted>") }
