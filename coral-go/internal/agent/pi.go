package agent

import (
	"bufio"
	"encoding/json"
	"github.com/subgentic/coral/internal/logsafe"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// PiAgent implements the Agent interface for the Pi coding agent CLI.
type PiAgent struct{}

func (a *PiAgent) AgentType() string    { return at.Pi }
func (a *PiAgent) SupportsResume() bool { return true }

// HistoryBasePath is where Coral keeps the sessions of the Pi agents it launched: <data dir>/pi-sessions/<Coral session id>/ (Pi runs with --session-dir there, pi.go LaunchCommand). A Pi started by hand
// keeps its sessions in ~/.pi/agent/sessions and is not Coral's to list (#11092).
func (a *PiAgent) HistoryBasePath() string {
	if v := os.Getenv("CORAL_DATA_DIR"); v != "" {
		return filepath.Join(v, "pi-sessions")
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".coral", "pi-sessions")
}

func (a *PiAgent) HistoryGlobPattern() string { return "*/*.jsonl" }

func (a *PiAgent) ExtractSessions(basePath string, knownMtimes map[string]float64) ([]IndexedSession, error) {
	if basePath == "" {
		return nil, nil
	}
	if _, err := os.Stat(basePath); os.IsNotExist(err) {
		return nil, nil
	}

	var sessions []IndexedSession
	err := filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		mtime := float64(info.ModTime().Unix())
		if prev, ok := knownMtimes[path]; ok && prev == mtime {
			return nil
		}
		sess, parseErr := parsePiSession(path, mtime)
		if parseErr != nil {
			slog.Debug("pi: failed to parse session file", "path", logsafe.Dir(path), "error", parseErr)
			return nil
		}
		if sess != nil {
			sessions = append(sessions, *sess)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return sessions, nil
}

// piContentText is the text of a Pi message: its content is a string, or a list of blocks of which the text ones are what was said (thinking, tool calls and tool arguments are not).
func piContentText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var parts []string
		for _, b := range c {
			if m, ok := b.(map[string]any); ok && m["type"] == "text" {
				if t, _ := m["text"].(string); t != "" {
					parts = append(parts, t)
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func parsePiSession(fpath string, mtime float64) (*IndexedSession, error) {
	f, err := openHistoryFile(fpath) // regular file, never a link or FIFO (#3601, W21)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var sessionID string
	var firstTS, lastTS *string
	var summary, firstMsg string
	var fts FTSBodyBuilder
	msgCount := 0

	for scanner.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			continue
		}

		entryType, _ := entry["type"].(string)

		switch entryType {
		case "session":
			if id, ok := entry["id"].(string); ok {
				sessionID = id
			}
		case "message":
			// Pi 1.4.0 writes {"type":"message","message":{"role","content":[blocks]}}. An older flat entry (role and content beside the type) is read the same way.
			msg, _ := entry["message"].(map[string]any)
			if msg == nil {
				msg = entry
			}
			role, _ := msg["role"].(string)
			if role != "user" && role != "assistant" {
				break // a system prompt, a tool result and a shell run are not what either side said
			}
			text := piContentText(msg["content"])
			if role == "assistant" && text == "" {
				break // a turn of tool calls or thinking only: nothing to read or search
			}
			msgCount++
			ts, _ := entry["timestamp"].(string)
			if ts != "" {
				if firstTS == nil {
					firstTS = &ts
				}
				tsCopy := ts
				lastTS = &tsCopy
			}
			fts.Add(text)
			if role == "user" && text != "" {
				if firstMsg == "" {
					if t, ok := typedText(text); ok {
						firstMsg = clipFirstMessage(t)
					}
				}
				if summary == "" {
					summary = redactedCut(text, 200)
				}
			}
		}
	}

	// A Coral-launched Pi keeps its file in pi-sessions/<Coral session id>/: that folder's name is the id the live row, the chat and the token poller use, so the history row has it too.
	if dir := filepath.Base(filepath.Dir(fpath)); IsResumeID(at.Pi, dir) {
		sessionID = dir
	}
	if sessionID == "" {
		base := filepath.Base(fpath)
		sessionID = strings.TrimSuffix(base, ".jsonl")
	}

	return &IndexedSession{
		SessionID:        sessionID,
		SourceType:       "pi",
		SourceFile:       fpath,
		FileMtime:        mtime,
		FirstTimestamp:   firstTS,
		LastTimestamp:    lastTS,
		MessageCount:     msgCount,
		DisplaySummary:   summary,
		FirstUserMessage: firstMsg,
		IndexVersion:     HistoryIndexVersion,
		FTSBody:          buildFTSBody(summary, &fts),
	}, nil
}

func (a *PiAgent) LaunchCommand(params LaunchParams) (string, error) {
	files := &launchFiles{}
	bin := resolveBinary(params.CLIPath, "pi")
	var parts []string
	// raw: the shell syntax this builder makes itself; every other part is quoted (#3362).
	var raw []string

	// Build system prompt for --append-system-prompt
	var sysParts []string
	if proto := readProtocolFile(params.ProtocolPath); proto != "" {
		sysParts = append(sysParts, proto)
	}
	boardSysPrompt := BuildBoardSystemPrompt(params.BoardName, params.Role, "", params.PromptOverrides, params.BoardType)
	if boardSysPrompt != "" {
		sysParts = append(sysParts, boardSysPrompt)
	}
	sysParts = appendCoralSessionMarker(sysParts, params.SessionID)

	// Export env vars
	// Coral environment, built by CoralEnv so every launch path agrees.
	for _, kv := range CoralEnv(params) {
		export := formatEnvExport(kv[0], kv[1])
		raw = append(raw, export)
		parts = append(parts, export)
	}
	parts = append(parts, bin)

	// Use a per-session directory so Pi's internal sessions map to Coral sessions.
	// On resume, point to the old session dir and use --continue.
	coralDir := params.CoralDir
	if coralDir == "" {
		if v := os.Getenv("CORAL_DATA_DIR"); v != "" {
			coralDir = v
		} else if home, err := os.UserHomeDir(); err == nil {
			coralDir = filepath.Join(home, ".coral")
		}
	}
	// A resume id from the request is joined into the session-dir path, so it must be a
	// canonical session id; an invalid one is ignored, starting a fresh session rather than
	// reaching outside pi-sessions (#3582). params.SessionID is server-generated.
	resumeID := params.ResumeSessionID
	if resumeID != "" && !IsResumeID(at.Pi, resumeID) {
		resumeID = ""
	}
	if coralDir != "" {
		effectiveID := params.SessionID
		if resumeID != "" {
			effectiveID = resumeID
		}
		sessionDir := filepath.Join(coralDir, "pi-sessions", effectiveID)
		os.MkdirAll(sessionDir, 0o700)
		parts = append(parts, "--session-dir", sessionDir)
		if resumeID != "" {
			parts = append(parts, "--continue")
		}
	}

	// Pass through user flags, dropping ones Pi doesn't understand
	unsupportedFlags := map[string]bool{
		"--permission-mode": true, "--settings": true, "--session-id": true,
		"--dangerously-skip-permissions": true, "--full-auto": true,
		"--approval-mode": true, "--sandbox": true, "--yolo": true,
		"--session": true, "--session-dir": true,
	}
	skipNext := false
	for _, flag := range params.Flags {
		if skipNext {
			skipNext = false
			continue
		}
		if unsupportedFlags[flag] {
			if flag == "--permission-mode" || flag == "--approval-mode" || flag == "--sandbox" || flag == "--session" || flag == "--session-id" || flag == "--session-dir" {
				skipNext = true
			}
			continue
		}
		parts = append(parts, flag)
	}

	// System prompt via --append-system-prompt with temp file
	if len(sysParts) > 0 {
		arg := files.promptArg("pi_sys", params.SessionID, "md", "", strings.Join(sysParts, "\n\n"))
		raw = append(raw, arg)
		parts = append(parts, "--append-system-prompt", arg)
	}

	// Action prompt as positional argument
	cliPrompt := BuildBoardActionPrompt(params.boardPromptName(), params.Role, params.Prompt, params.PromptOverrides, params.BoardType)
	if cliPrompt == "" {
		cliPrompt = params.Prompt
	}
	if cliPrompt != "" {
		cliPrompt = guardPositionalPrompt(cliPrompt)
		arg := files.promptArg("pi_prompt", params.SessionID, "txt", "", cliPrompt)
		raw = append(raw, arg)
		parts = append(parts, arg)
	}

	parts, raw = withSessionToken(parts, raw, params, at.Pi)
	return files.done(ShellJoin(parts, raw...))
}

// guardPositionalPrompt makes text safe as pi's positional prompt, which has no "--" to end its options. pi reads
// an argument that starts with "-" as an option and one that starts with "@" as a file to attach, so a prompt that
// starts with either (team instructions, a board message and an imported team all become prompts) gets a newline
// in front: the agent reads the same text, and the argument no longer looks like an option or a file (#36). The
// other agents end their options with "--" (claude, codex) or take the prompt as the value of -i (agy, whose
// parser takes the next argument as an option's value whatever it starts with).
func guardPositionalPrompt(prompt string) string {
	if strings.HasPrefix(prompt, "-") || strings.HasPrefix(prompt, "@") {
		return "\n" + prompt
	}
	return prompt
}

// guardSlashPrompt keeps Claude's interactive launch from reading a prompt that starts with "/" as a slash command:
// "/help" opens the Help dialog even after "--", where the same text with a newline (or a space) in front is an ordinary
// prompt (checked against the real CLI). Team text and board messages reach launch prompts. Only Claude: agy expands
// slash commands whatever is in front of them, and Codex has not been checked.
func guardSlashPrompt(prompt string) string {
	if strings.HasPrefix(prompt, "/") {
		return "\n" + prompt
	}
	return prompt
}
