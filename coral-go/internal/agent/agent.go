// Package agent provides agent implementations for Claude, Antigravity (agy), Codex, and Pi.
package agent

import (
	"fmt"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/pkg/redact"
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

// HistoryIndexVersion is the version of the History parsers: a session indexed with an older one is read again once (its row has no first user message, #6207). Every scanner stamps it on the rows it
// writes; store.GetHistoryMtimes is given it, so the next pass re-reads the files of older rows whatever their mtime. Version 1 was the guardian-aware Codex parser (#6081); version 4 keeps the launch prompt out of the first user message (#7756).
const HistoryIndexVersion = 4

// firstMessageLimit is how much of the first user message is kept.
const firstMessageLimit = 200

// redactBound is how much of a message is looked at for secrets before it is clipped: more than any clip keeps, and a bound on the work for a message of megabytes.
const redactBound = 64 << 10

// redactedCut is the first n bytes of text, redacted BEFORE it is cut and cut where no token can be split (redact.Cut), as a COPY (a substring would keep the whole message alive). A secret that straddles a plain
// byte cut is left as part of a token that the detector no longer recognises: a GitHub token short of its last character passed the redactor unchanged (#3733's class, Security's SHOULD on #6207). Text that
// cannot be checked gives "" (fail closed).
func redactedCut(text string, n int) string {
	if len(text) > redactBound {
		text = strings.ToValidUTF8(text[:redactBound], "")
	}
	out, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		return ""
	}
	s := string(out)
	return strings.Clone(s[:redact.Cut(s, n)])
}

// clipFirstMessage is the first user message as a short line: redacted whole first (a multi-line secret such as a PEM key is only seen whole), then whitespace folded and at most firstMessageLimit bytes kept,
// cut where no token can be split.
func clipFirstMessage(text string) string {
	if len(text) > redactBound {
		text = strings.ToValidUTF8(text[:redactBound], "")
	}
	out, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		return ""
	}
	return redactedCut(strings.Join(strings.Fields(string(out)), " "), firstMessageLimit)
}

// ideContextR is one IDE context block the editor extension puts in front of what the person typed (<ide_opened_file>The user opened ...</ide_opened_file>, <ide_selection>...</ide_selection>), at the start of the text.
var ideContextR = regexp.MustCompile(`(?s)^\s*<(ide_[a-z_]+)>.*?</(ide_[a-z_]+)>`)

// typedText is what the person typed in a user entry's text, and whether there is any: the IDE context blocks in front of it are dropped and the rest is kept (#6268: a message that opened with an
// <ide_opened_file> tag was skipped whole, so the title fell to a later message), and an entry that is only context, or the CLI's own text, has none.
func typedText(text string) (string, bool) {
	for {
		m := ideContextR.FindStringSubmatch(text)
		if m == nil || m[1] != m[2] {
			break
		}
		text = text[len(m[0]):]
	}
	// The extension can put its context after the typed text as well (a selection): those blocks are not typed text either.
	for {
		t := strings.TrimRight(text, " \t\r\n")
		m := ideTrailingCloseR.FindStringSubmatch(t)
		if m == nil {
			break
		}
		start := strings.LastIndex(t[:len(t)-len(m[0])], "<"+m[1]+">")
		if start < 0 {
			break // closed but never opened: left as typed
		}
		text = t[:start]
	}
	if injectedUserText(text) {
		return "", false
	}
	return text, true
}

// ideTrailingCloseR is the closing tag of an IDE context block at the very end of the text.
var ideTrailingCloseR = regexp.MustCompile(`</(ide_[a-z_]+)>$`)

// Markers of the text Coral itself puts in a chat's launch prompt: the board action prompts say this, and the distilled-knowledge section opens with this heading and sentence (routes.InjectKnowledgeIntoPrompt).
const (
	launchPromptBoardMarker     = "You were automatically joined to message board"
	KnowledgeSectionHeading     = "## Your Institutional Knowledge"
	KnowledgeSectionIntro       = "The following is distilled knowledge from your previous sessions."
	launchPromptKnowledgeMarker = KnowledgeSectionHeading + "\n\n" + KnowledgeSectionIntro
)

// IsLaunchPromptText reports whether a user entry's text is the launch prompt Coral gave the agent (its role prompt with the knowledge section and the board's action text after it), not something a person typed (#7756).
// A launch prompt that has neither the knowledge section nor the board text (a role prompt alone) cannot be told from a typed message here.
func IsLaunchPromptText(text string) bool {
	return strings.Contains(text, launchPromptBoardMarker) || strings.Contains(text, launchPromptKnowledgeMarker)
}

// injectedUserText reports whether a user entry's text is the CLI's own and not something the person typed: a slash command's tags, the output of one, or a system reminder or environment block.
func injectedUserText(text string) bool {
	t := strings.TrimSpace(text)
	for _, p := range []string{"<command-name>", "<command-message>", "<local-command-", "<system-reminder>", "<environment_context>", "<user_instructions>", "<ide_", "<task-notification>", "[Request interrupted by user", "# AGENTS.md instructions for", "Caveat: The messages below were generated by the user while running local commands"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return t == "" || IsLaunchPromptText(t)
}

// ftsBodyLimit caps how much of one session's text enters the search index.
// A long session can run to megabytes; indexing all of it across hundreds of
// sessions would cost far more disk than the search is worth. 256 KiB is
// roughly a hundred thousand words, which is more than enough for the "what
// was that session about" query this feature exists to answer.
const ftsBodyLimit = 256 * 1024

// FTSBodyBuilder accumulates the searchable text of one session, bounded.
//
// It exists so every agent's extractor builds the body the same way. FTSBody
// was declared and read but never assigned by any of the four extractors, so
// the guard in the indexer was never true, UpsertFTS was never called, and
// session_fts stayed empty — in production, across 56 indexed sessions, for
// months. Building it in one place is what stops three of the four being
// fixed and the fourth quietly not.
type FTSBodyBuilder struct {
	b    strings.Builder
	full bool
}

// Add appends one message's text. Empty strings are ignored, and everything
// after the limit is dropped rather than truncated mid-append, so the body
// never ends in half a word.
func (f *FTSBodyBuilder) Add(text string) {
	if f.full || text == "" {
		return
	}
	if f.b.Len() > 0 {
		f.b.WriteByte('\n')
	}
	f.b.WriteString(text)
	if f.b.Len() >= ftsBodyLimit {
		f.full = true
	}
}

// String returns the accumulated body.
func (f *FTSBodyBuilder) String() string { return f.b.String() }

// buildFTSBody returns the searchable body for a session, seeded with the
// display summary.
//
// Seeding matters: the summary is what the session list shows, so a word a
// user can see on screen must be findable. That was the exact symptom — a
// summary reading "MEMORY-TOKEN-7731 the capital of the demo is Coralville"
// was on screen while a search for "Coralville" returned nothing.
func buildFTSBody(summary string, body *FTSBodyBuilder) string {
	var out FTSBodyBuilder
	out.Add(summary)
	out.Add(body.String())
	return out.String()
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
