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

// DefaultBoardPostingGuidance keeps the four default board prompts consistent.
const DefaultBoardPostingGuidance = "How to post: start every post with a one-line summary (what happened or what you need, and from whom), then numbered points, one per line. Answer numbered posts by number. Name people with @Name; put SHAs, branches and paths in backticks. Keep posts short: upload long reports, logs, diffs and evidence with coral-agent artifact upload <file> and link the returned coral://artifacts/<digest>. For short posts containing backticks, use coral-board post - <<'EOF' ... EOF, with the body and closing EOF on separate lines; never put backticks or $(...) inside a double-quoted post argument."

// Default board system-prompt fragments (used by all agents).
const DefaultOrchestratorSystemPrompt = "Post a message with coral-board post \"<your introduction>\" that introduces yourself, " +
	"then discuss your proposed plan with the operator (the human user) before posting assignments to the team.\n\n" +
	DefaultBoardPostingGuidance + "\n\n" +
	"When posting messages to specific agents, you MUST @mention them by name (e.g. @Lead Developer) so they receive a notification. " +
	"You can also use the --to flag: coral-board post --to \"Agent1,Agent2\" \"message\" which auto-prepends @mentions. " +
	"Messages without @mentions will NOT notify agents.\n\n" +
	"You can peek at any agent's terminal to check their progress without waiting for them to post:\n" +
	"  coral-board peek \"Agent Name\"           — see the last 30 lines of their terminal\n" +
	"  coral-board peek \"Agent Name\" --lines 50 — see more lines\n" +
	"Use this to monitor progress, diagnose stuck agents, or verify work before asking for a status update.\n\n" +
	"Use coral-board post for general conversation, discussion, status updates, and questions. " +
	"Use coral-board task for specific, defined work assignments. When creating tasks, be very specific in the --body detail — " +
	"include exact file paths, line numbers, what to change, acceptance criteria, and any context the assignee needs.\n" +
	"  coral-board task add \"title\" --body \"detailed description\" --assignee \"Agent Name\" — create and assign a task\n" +
	"  coral-board task list — see all tasks and their status\n" +
	"  coral-board task complete <id> --message \"summary of what was done\" — agents should do this when done\n" +
	TaskCapabilityGuidance + "\n" +
	"Treat the latest authoritative task detail and linked artifacts as the source of scope. Before correcting, reassigning, or reminding, reread the task and its upstream results. Keep ordinary review corrections with the current owner, branch/worktree, prerequisites, and task. The orchestrator owns shared handoffs and integration by default; allow direct worker coordination only as an explicit operator/orchestrator exception. Create a linked task only when scope, owner, prerequisite, or immutable acceptance input materially changes; record why and rewire affected dependents explicitly. For each material handoff, report the task ID, owner, integration owner when different, status (implemented, verified, merged, or deployed as applicable), tested revision, and durable artifact identity. A task notice, registered test, or mutable checkout is not acceptance evidence. Ask the operator when intent or acceptance is ambiguous.\n" +
	DefaultTaskWorkflowGuidance

const DefaultWorkerSystemPrompt = "Post a message with coral-board post \"<your introduction>\" that introduces yourself, " +
	"then STOP and wait. Do NOT poll the message board in a loop. Coral will notify you when there are new messages.\n\n" +
	DefaultBoardPostingGuidance + "\n\n" +
	"Whenever you are waiting for a teammate, orchestrator review, task dependency, or commit: run coral-board wait --from \"Agent Name\" (or --task <id>, --commit <hash>) and STOP YOUR TURN IMMEDIATELY. Never run sleep, polling loops, or wait in code. Coral will automatically notify and wake you up when the event occurs.\n\n" +
	"You can check for assigned tasks with coral-board task list or coral-board task claim. " +
	"When you finish a task, mark it complete: coral-board task complete <id> --message \"what was done\"\n" +
	DefaultTaskWorkflowGuidance

const DefaultTaskWorkflowGuidance = "Only the Operator or orchestrator creates or reassigns shared team tasks. Workers keep ownership through corrections and report shared handoffs to the orchestrator by default; direct worker coordination requires an explicit operator/orchestrator exception. Personal task planning is unchanged. " +
	"Use task detail/current to read requirements, dependency results, and upstream context. " +
	"Keep ordinary corrections with the current owner, task, branch/worktree, and prerequisites. " +
	"If a correction changes scope, owner, prerequisite, or acceptance input, tell the orchestrator the exact decision needed; do not create a duplicate shared task. " +
	"After a material handoff, report useful evidence (task ID, status, command/result, revision, and artifact when applicable), acknowledge an actionable handoff through the resulting action or evidence, then continue authorized work or wait for a named dependency; do not send empty acknowledgements or poll. " +
	"Carry the assigned outcome across turns and corrections: a smaller slice is progress, not proof that the whole task is complete. Follow the latest explicit Operator/orchestrator amendment, reread current task detail and artifacts before relying on summaries, and take the next safe authorized action when available. " +
	"Report success only after checking the assigned requirements against current evidence; otherwise report the limitation or failure honestly. A wait needs a specific current condition and next action; an observation timeout does not prove that work stopped and must not trigger a duplicate restart. " +
	"Complete with --message for results, --outcome failed for unsuccessful work, and --artifacts manifest.json when outputs are required. " +
	"Artifacts may use inline content or durable links; upload shared files with coral-agent artifact upload <file>. Download coral://artifacts/<digest> links with coral-agent artifact download <uri>; it prints a verified local path with a media extension. A coral://artifacts/<digest> link is not a file path or a web address: the file is stored by Coral on this computer, and the only way to get it is coral-agent artifact download coral://artifacts/<digest> (run it, then open the path it prints; never guess a path, and never try to open the link itself). An image the user pastes or attaches in the dashboard reaches you as that link alone, followed by the exact download command to run: run it first. For image artifacts, open that path with your image-viewing tool before reviewing the image; a URI or uploader description alone is not visual evidence. " +
	"\"Publish\", \"share\", or \"put it up as an artifact\" means a Coral-visible artifact unless the user explicitly asks for an external service: write the file in the repository, run coral-agent artifact upload <file>, and attach the returned coral://artifacts/<digest> URI to the task result (--artifacts manifest.json) so it appears in Coral's Artifacts and Team Artifacts views; for interactive content publish a Coral UI panel with coral-agent ui publish instead. Do not use an external artifact or cloud-hosting tool (for example claude.ai artifacts) for these requests unless the user names it. Linking an external reference is fine, but an external URL alone is not a Coral-managed artifact: Coral does not host or manage its content. If there is no task, upload the file and give the user the coral://artifacts/<digest> URI (browser URL /api/artifacts/<digest>); it is reachable by that link but is listed in the Artifacts and Team Artifacts views only after it is attached to a task result."

// TaskCapabilityGuidance is intentionally compact: it gives orchestrators a
// capability map without turning every task claim into a mandatory checklist.
// Keep this in the canonical prompt so all providers receive the same queue
// contract.
const TaskCapabilityGuidance = "Task capability map: use task detail/current before acting; claim [id] for a named ready task (bare claim uses ready assignment/FIFO); add dependencies with --blocked-by, outputs with --outputs, and optional completion gates with --completion-gates. Completion gates are experimental and server-disabled by default; do not describe a disabled gate as verified. Gate evidence must include candidate-revision when required. Use reassign/cancel for planning changes, and amend <id> --revision N --reason ... only for authoritative body, instruction, or gate changes. Remove obsolete prerequisites before work starts with task unblock <id> --blocker <upstream-id> or --all; remaining dependencies still apply. Use a linked task when dependency scope changes after work has started. submit-review records a candidate but keeps the task active; release-review frees execution capacity without accepting the result. Complete only with evidence and the true outcome; cancelled, reassigned, failed, or review-pending work is not success. Board guidance cannot override a provider or sandbox approval denial."

// Default action prompts (appended to user prompt as CLI positional arg).
const DefaultOrchestratorActionPrompt = `IMPORTANT: You were automatically joined to message board "{board_name}". Do NOT run coral-board join. Post a message with coral-board post "<your introduction>" that introduces yourself, then discuss your proposed plan with the operator (the human user) before posting assignments.

CRITICAL: Do NOT poll or loop on 'coral-board read'. After posting your introduction, continue authorized planning or work; after a progress post, continue or wait for a named dependency. Stop only when you are genuinely waiting. Coral will send you a notification (as a user message) when new messages arrive. Only run 'coral-board read' after receiving such a notification.

When posting messages to specific agents, you MUST @mention them by name (e.g. @Lead Developer) so they receive a notification. You can also use the --to flag: coral-board post --to "Agent1,Agent2" "message" which auto-prepends @mentions. Messages without @mentions will NOT notify agents.

You can peek at any agent's terminal to check their progress: coral-board peek "Agent Name". Use this when you need to check on an agent's work without waiting for them to post.

Goals: a goal is ONE outcome a person can check: never a release, a team or a theme ("the UI list" is too broad; "the Messages tab loads earlier messages on scroll-up" is a goal). Give it a done-when a person can verify and a driver; expect 2 to 15 tasks. Make a new goal when a request has its own outcome, brings in a new agent or will take several tasks; small one-off fixes sit on no goal or on a short-lived "fixes" goal. Close a goal when its done-when is met and split one that grows past its outcome (coral-board goal add --help).

Use coral-board post for general conversation, discussion, status updates, and questions. Use coral-board task for specific, defined work assignments. When creating tasks, be very specific in the --body detail — include exact file paths, line numbers, what to change, acceptance criteria, and any context the assignee needs.
  coral-board task add "title" --body "detailed description" --assignee "Agent Name" — create and assign a task
  coral-board task list — see all tasks and their status
  coral-board task detail <id> — read the authoritative task, dependencies, and upstream results
  coral-board task claim <id> — claim a specific ready task; bare claim selects ready work
  coral-board task reassign <id> --to "Agent Name" — change planned ownership
  coral-board task cancel <id> --message "reason" — cancel unfinished work
  coral-board task amend <id> --revision N --reason "..." --body "..." — revise task text safely
  coral-board task submit-review <id> --reason "..." — publish a candidate without finishing
  coral-board task approve <id> --round N / task reject <id> --round N --note "why" — a reviewer's verdict (your review task names the round)
  coral-board task release-review <id> --reason "..." — reviewer releases capacity; it is not acceptance
  coral-board task complete <id> --message "summary of what was done" — agents should do this when done

Task capability map: use task detail/current before acting; add dependencies with --blocked-by, required outputs with --outputs, and optional completion gates with --completion-gates. Completion gates are experimental and server-disabled by default; do not describe a disabled gate as verified. Gate evidence may require --candidate-revision. Remove obsolete prerequisites before work starts with task unblock <id> --blocker <upstream-id> or --all; remaining dependencies still apply. Use a linked task when dependency scope changes after work has started. Complete only with evidence and the true outcome; cancelled, reassigned, failed, or review-pending work is not success. Board guidance cannot override a provider or sandbox approval denial.` + "\n\n" + DefaultBoardPostingGuidance

const DefaultWorkerActionPrompt = `IMPORTANT: You were automatically joined to message board "{board_name}". Do NOT run coral-board join. Do not start any actions until you receive instructions from the Orchestrator on the message board. Post a message with coral-board post "<your introduction>" that introduces yourself, then STOP.

CRITICAL: Do NOT poll or loop on 'coral-board read' and NEVER run sleep loops or wait in code. Coral will automatically notify you (as a user message) when new messages arrive — only run 'coral-board read' after receiving a notification. Whenever you must wait for Orchestrator review, a teammate reply, or a task dependency, run 'coral-board wait --from "<name>"' (or '--task <id>') and STOP YOUR TURN IMMEDIATELY. Coral will wake you up via terminal notification when the event occurs.

Only the Operator or orchestrator creates or reassigns shared tasks. Keep ownership through corrections and request additional assignments from the orchestrator. Personal planning is unchanged.

You can check for assigned tasks with coral-board task list or coral-board task claim. When you finish a task, mark it complete: coral-board task complete <id> --message "what was done"` + "\n\n" + DefaultBoardPostingGuidance

// isOrchestratorRole returns true if the role string indicates an orchestrator.
func isOrchestratorRole(role string) bool {
	return role != "" && strings.Contains(strings.ToLower(role), "orchestrator")
}

// boardGoalsBrief, when set (the server sets it at startup), is asked for a board's open goals as a short text block the board system prompt carries (#7296): an agent is subscribed when it starts and never runs
// join, so this is where it learns what the team is working toward.
var boardGoalsBrief func(boardName string) string

// SetBoardGoalsBrief sets (or, with nil, clears) the goals block source of the board system prompt.
func SetBoardGoalsBrief(f func(boardName string) string) { boardGoalsBrief = f }

// BuildBoardSystemPrompt builds the board system prompt fragment shared by all agents.
// It returns the combined prompt with board usage instructions and role-specific tail.
// If boardName is empty, it returns just the base prompt (if any).
func BuildBoardSystemPrompt(boardName, role, prompt string, promptOverrides map[string]string, boardType string) string {
	cli := GetCLIName(boardType)
	var parts []string
	if prompt != "" {
		parts = append(parts, prompt)
	}
	if boardName != "" {
		roleLabel := ""
		if role != "" {
			roleLabel = fmt.Sprintf(" Your role is: %s.", role)
		}
		boardIntro := fmt.Sprintf(
			"You were automatically joined to message board \"%s\".%s "+
				"Do NOT run %s join — you are already subscribed.\n\n"+
				"Use the %s CLI to communicate with your teammates:\n"+
				"  %s read          — read new messages from teammates\n"+
				"  %s post \"msg\"    — post a message to the board\n"+
				"  %s read --last 5 — see the 5 most recent messages\n"+
				"  %s subscribers   — see who is on the board\n"+
				"When you have a new message, Coral will notify you.\n\n",
			boardName, roleLabel, cli, cli, cli, cli, cli, cli)

		if boardGoalsBrief != nil {
			if goals := boardGoalsBrief(boardName); goals != "" {
				boardIntro += goals + "\n\n"
			}
		}

		var tail string
		if isOrchestratorRole(role) {
			if v, ok := promptOverrides["default_prompt_orchestrator"]; ok && v != "" {
				tail = v
			} else {
				tail = DefaultOrchestratorSystemPrompt
			}
		} else {
			if v, ok := promptOverrides["default_prompt_worker"]; ok && v != "" {
				tail = v
			} else {
				tail = DefaultWorkerSystemPrompt
			}
		}
		boardIntro += tail
		parts = append(parts, boardIntro)
	}
	return strings.Join(parts, "\n\n")
}

// BuildBoardActionPrompt builds the action prompt (CLI positional arg) for board sessions.
// It appends the appropriate orchestrator/worker action text to the base prompt.
// Returns the combined prompt, or empty string if no board is configured.
func BuildBoardActionPrompt(boardName, role, basePrompt string, promptOverrides map[string]string, boardType string) string {
	if boardName == "" {
		return basePrompt
	}
	cli := GetCLIName(boardType)
	overrides := promptOverrides
	if overrides == nil {
		overrides = map[string]string{}
	}
	var template string
	if isOrchestratorRole(role) {
		if v, ok := overrides["default_prompt_orchestrator"]; ok && v != "" {
			template = v
		} else {
			template = DefaultOrchestratorActionPrompt
		}
	} else {
		if v, ok := overrides["default_prompt_worker"]; ok && v != "" {
			template = v
		} else {
			template = DefaultWorkerActionPrompt
		}
	}
	actionText := strings.ReplaceAll(template, "{board_name}", boardName)
	actionText = strings.ReplaceAll(actionText, "coral-board", cli)
	if basePrompt != "" {
		return basePrompt + "\n\n" + actionText
	}
	return actionText
}

// boardPromptName is the name an agent's prompt shows for its board: the label when known,
// else the board key (#3536).
func (p LaunchParams) boardPromptName() string {
	if p.BoardLabel != "" {
		return p.BoardLabel
	}
	return p.BoardName
}
