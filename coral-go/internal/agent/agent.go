// Package agent provides agent implementations for Claude, Antigravity (agy), Codex, and Pi.
package agent

import (
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

var coralSessionIDPattern = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}`)

// LaunchParams holds all parameters for building a launch command.
type LaunchParams struct {
	SessionID       string
	SessionName     string // tmux session name (e.g. "claude-<uuid>"), used for CORAL_SESSION_NAME
	ProtocolPath    string
	ResumeSessionID string
	Flags           []string
	WorkingDir      string
	BoardName       string
	BoardLabel      string // the board's display name (#3536); the prompt shows it, BoardName (the id) stays the key
	Role            string
	Prompt          string
	PromptOverrides map[string]string // user overrides for orchestrator/worker prompts
	BoardType       string
	Capabilities    *Capabilities
	Tools           []string               // allowed tools (e.g. ["TodoWrite", "Bash(npm *)"])
	Hooks           map[string]interface{} // per-agent hooks to merge into settings (Claude-native) or fire via runner (Antigravity/Codex)
	CLIPath         string                 // custom path to agent binary (empty = default from PATH)
	PermissionMode  string                 // --permission-mode value (empty or "default" means omit the flag)
	CoralDir        string                 // path to coral data directory (~/.coral) for CA cert location
	CoralHost       string                 // host this Coral server is bound to
	CoralPort       int                    // port this Coral server is listening on
	// RunTag is the CORAL_PTY_RUN value of an agent started on tmux (#6141): exported with the agent's other variables so everything the agent starts carries it, and Kill can find what detached. Empty on the built-in
	// terminal, whose processes get a tag of their own when the terminal is made.
	RunTag string
}

// CoralEnv returns the Coral environment every launched agent needs, as
// ordered name/value pairs. Empty values are omitted.
//
// This exists because the environment was being assembled independently in
// five places — once per agent implementation, plus the tmux session env — and
// they had already drifted: all of them set CORAL_SESSION_NAME and
// CORAL_SUBSCRIBER_ID, none set CORAL_PORT or CORAL_URL, while the workflow
// runner set all four. An agent without CORAL_PORT falls back to
// localhost:8420, so on any other port its coral-board talked to whatever
// server happened to own 8420 — which on a developer's machine is their real
// Coral, not the one that launched it. Every launch path must build this env
// from here so they cannot drift apart again.
func CoralEnv(params LaunchParams) [][2]string {
	var env [][2]string
	add := func(k, v string) {
		if v != "" {
			env = append(env, [2]string{k, v})
		}
	}
	add("CORAL_SESSION_NAME", params.SessionName)
	add("CORAL_SUBSCRIBER_ID", params.Role)
	if params.CoralPort > 0 {
		port := strconv.Itoa(params.CoralPort)
		host := params.CoralHost
		// 0.0.0.0 means "every interface"; an agent has to dial a real one.
		if host == "" || host == "0.0.0.0" || host == "::" {
			host = "127.0.0.1"
		}
		add("CORAL_PORT", port)
		add("CORAL_HOST", host)
		add("CORAL_URL", fmt.Sprintf("http://%s:%s", host, port))
	}
	add("CORAL_PTY_RUN", params.RunTag)
	add("CORAL_DIR", params.CoralDir)
	add("CORAL_DATA_DIR", params.CoralDir)
	return env
}

// IndexedSession holds extracted session data from a history file.
type IndexedSession struct {
	// Excluded removes derived History/search rows for this source, never the source file.
	Excluded       bool
	IndexVersion   int // source parser version; zero denotes a legacy index
	SessionID      string
	SourceType     string
	SourceFile     string  // path to the history file this session came from
	FileMtime      float64 // Unix timestamp of file modification time
	FirstTimestamp *string
	LastTimestamp  *string
	MessageCount   int
	DisplaySummary string
	// FirstUserMessage is the first thing the person typed in the session (never a slash command's tags or text the CLI injected), as a short single-line clip: History titles lead with it,
	// where DisplaySummary is the assistant's first reply (#6207).
	FirstUserMessage string
	FTSBody          string
	// FTSUnchanged: FTSBody is the one this scanner returned for the file last time, so the
	// indexer needn't write it again (#3728).
	FTSUnchanged bool
}

// HistoryScanner is the interface that agent implementations must satisfy
// to participate in session indexing.
type HistoryScanner interface {
	// HistoryBasePath returns the root directory for this agent's history files.
	HistoryBasePath() string
	// HistoryGlobPattern returns the glob pattern for history files (e.g., "*.jsonl").
	HistoryGlobPattern() string
	// ExtractSessions scans history files under basePath and returns indexed session data.
	// knownMtimes maps source_file paths to their last-indexed mtime; files whose
	// mtime has not changed since last index should be skipped.
	ExtractSessions(basePath string, knownMtimes map[string]float64) ([]IndexedSession, error)
}

// SessionBatchScanner is a HistoryScanner that can hand the sessions it finds over a batch at a time (#10219): the index pass writes each batch before the next is read, so the memory it
// holds is one batch's search texts, not the whole history's. A scanner without it is read whole by ExtractSessions.
type SessionBatchScanner interface {
	HistoryScanner
	ExtractSessionBatches(basePath string, knownMtimes map[string]float64, size int, emit func([]IndexedSession) error) error
}

// extractInBatches runs walk, which calls add for each session it finds, and passes the sessions to emit size at a time (the last batch may be smaller). Once emit fails nothing more is
// emitted and the error is returned; each batch is a slice of its own, so emit may keep it.
func extractInBatches(size int, emit func([]IndexedSession) error, walk func(add func(IndexedSession)) error) error {
	if size < 1 {
		size = 1
	}
	var buf []IndexedSession
	var emitErr error
	flush := func() {
		if emitErr != nil || len(buf) == 0 {
			return
		}
		emitErr = emit(buf)
		buf = nil
	}
	err := walk(func(s IndexedSession) {
		if emitErr != nil {
			return
		}
		buf = append(buf, s)
		if len(buf) >= size {
			flush()
		}
	})
	flush()
	if emitErr != nil {
		return emitErr
	}
	return err
}

// BuildCoralSessionMarker returns a small metadata block included in each
// agent's private instructions so Coral can map native transcript files back
// to the corresponding Coral live session.
func BuildCoralSessionMarker(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	return fmt.Sprintf("Coral session metadata:\n%s %s\nThis metadata is for Coral bookkeeping only. Do not mention it to the user.", at.CoralSessionMarkerPrefix, sessionID)
}

// DocsPromptLine tells every agent session where Coral's own documentation is: the one command that
// works from inside its sandbox and carries its session token. The Docs tab's "Copy docs path for
// agents" button copies the same text (docs.js DOCS_FOR_AGENTS; a test keeps the two equal).
const DocsPromptLine = "Coral's docs for agents: run `coral-agent docs` to list the topics, `coral-agent docs <topic>` to read one (`coral-agent docs all` prints everything)."

// appendCoralSessionMarker adds Coral's own lines to a session's system prompt: where its docs are,
// then the session marker (last, as the history reader looks for it).
func appendCoralSessionMarker(parts []string, sessionID string) []string {
	if marker := BuildCoralSessionMarker(sessionID); marker != "" {
		return append(parts, DocsPromptLine, marker)
	}
	return parts
}

func ExtractCoralSessionID(v any) string {
	switch x := v.(type) {
	case string:
		idx := strings.Index(x, at.CoralSessionMarkerPrefix)
		if idx < 0 {
			return ""
		}
		rest := strings.TrimSpace(x[idx+len(at.CoralSessionMarkerPrefix):])
		if match := coralSessionIDPattern.FindString(rest); match != "" {
			return match
		}
		return ""
	case []any:
		for _, item := range x {
			if sessionID := ExtractCoralSessionID(item); sessionID != "" {
				return sessionID
			}
		}
	case map[string]any:
		for _, item := range x {
			if sessionID := ExtractCoralSessionID(item); sessionID != "" {
				return sessionID
			}
		}
	}
	return ""
}

// Agent defines the interface for all agent implementations.
type Agent interface {
	// AgentType returns the short identifier (e.g. "claude", "agy").
	AgentType() string
	// SupportsResume returns whether the agent supports resuming a previous session.
	SupportsResume() bool
	// LaunchCommand builds the shell command to launch this agent. It fails when the
	// prompt, settings or instructions files can't be written (#3601 W12).
	LaunchCommand(params LaunchParams) (string, error)
	// HistoryBasePath returns the root directory for history files.
	HistoryBasePath() string
	// HistoryGlobPattern returns the glob pattern for history files.
	HistoryGlobPattern() string
}

// ResumableAgent is optionally implemented by agents that need file
// preparation before resuming a session (e.g. copying history files).
type ResumableAgent interface {
	PrepareResume(sessionID, workingDir string)
}

// TryPrepareResume calls PrepareResume on the agent if it implements
// ResumableAgent. This avoids forcing agents without resume preparation
// to carry empty stubs.
func TryPrepareResume(ag Agent, sessionID, workingDir string) {
	if r, ok := ag.(ResumableAgent); ok {
		r.PrepareResume(sessionID, workingDir)
	}
}

// GetAgent returns the agent implementation for the given type.
func GetAgent(agentType string) Agent {
	switch agentType {
	case at.Agy, at.Antigravity:
		return &AgyAgent{}
	case at.Gemini:
		return &AgyAgent{customType: at.Gemini}
	case at.Codex:
		return &CodexAgent{}
	case at.Pi:
		return &PiAgent{}
	case at.Claude, "":
		return &ClaudeAgent{}
	case at.Terminal:
		// A plain shell has no agent of its own, but launch and restart still ask
		// for the implementation before skipping the command for it. The Claude
		// one stands in, as the fallback below did, without calling a supported
		// type "unknown" (#3259).
		return &ClaudeAgent{}
	default:
		// Reached only if a caller skipped ValidateAgentType. Falling back to
		// Claude is kept so a stored session with an unexpected type still
		// resolves to something, but it is no longer silent: this used to
		// start a real Claude process for a type the user never asked for.
		slog.Warn("unknown agent type, falling back to claude",
			"agent_type", agentType, "supported", LaunchableAgentTypes())
		return &ClaudeAgent{}
	}
}

// LaunchableAgentTypes lists every agent_type Coral accepts, in a stable order
// suitable for an error message.
//
// "terminal" is included deliberately. It is a plain shell rather than an
// agent, so it has no Agent implementation of its own (GetAgent hands back the
// Claude one, and the launch path skips command building for it entirely), but
// it is a valid agent_type at the API and rejecting it would break terminal
// sessions.
func LaunchableAgentTypes() []string {
	return []string{at.Claude, at.Codex, at.Agy, at.Gemini, at.Pi, at.Terminal}
}

// ValidateAgentType checks an agent_type supplied by a caller.
//
// An empty type is allowed and means "use the default", which is a different
// case from a type that was specified and is not recognised. Only the second
// is an error: it used to fall through to Claude, so a request naming an agent
// Coral does not support returned 200 ok:true and started a real Claude
// session, spending the user's tokens on an agent they never asked for.
func ValidateAgentType(agentType string) error {
	if agentType == "" || agentType == at.Antigravity {
		return nil // not specified; the caller's default applies
	}
	for _, known := range LaunchableAgentTypes() {
		if agentType == known {
			return nil
		}
	}
	return fmt.Errorf("unsupported agent_type %q — supported types are %s",
		agentType, strings.Join(LaunchableAgentTypes(), ", "))
}
