package routes

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/sessionstate"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/shellkill"
	"github.com/subgentic/coral/internal/store"
)

// A tool call the agent has started but not finished, reported by the
// PreToolUse hook. Claude Code writes a tool call to the transcript only once
// it completes, so while a permission prompt, an AskUserQuestion or a plan
// approval is open this is the only place the chat can learn what is being
// asked. Kept in memory: it only matters while the prompt is on screen.
type pendingTool struct {
	ToolUseID string         `json:"tool_use_id"`
	ToolName  string         `json:"tool_name"`
	Input     map[string]any `json:"input"`
	At        time.Time      `json:"at"`
}

type pendingTools struct {
	mu sync.Mutex
	m  map[string]pendingTool // session_id -> latest started tool
	// calls are all the tool calls a session has started and not finished (tool_use_id -> the call), so a permission request can be tied to the calls it may be for (#6687): the slot above
	// holds only the newest, and agents run tool calls in parallel.
	calls map[string]map[string]pendingTool
	// requestOpen are the sessions with a permission request of the agent's own open (#11352): its tool's PreToolUse that comes next says the permission was given. Only the marker is kept; the
	// request itself is in the event log.
	requestOpen map[string]bool
}

// requestIsOpen reports whether the session has a request of its own marked open.
func (p *pendingTools) requestIsOpen(sessionID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.requestOpen[sessionID]
}

// markRequest notes that a session has a request open (open) or no longer has (not open); it reports whether one was open before.
func (p *pendingTools) markRequest(sessionID string, open bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	was := p.requestOpen[sessionID]
	if open {
		if p.requestOpen == nil {
			p.requestOpen = map[string]bool{}
		}
		p.requestOpen[sessionID] = true
	} else {
		delete(p.requestOpen, sessionID)
	}
	return was
}

// maxCallsPerSession bounds what is remembered of one session's calls in flight.
const maxCallsPerSession = 64

// A prompt left open longer than this is stale (e.g. the hook for its
// completion never arrived).
const pendingToolTTL = 30 * time.Minute

func (p *pendingTools) set(sessionID string, t pendingTool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = map[string]pendingTool{}
	}
	p.m[sessionID] = t
	if t.ToolUseID != "" && len(t.ToolUseID) <= 128 {
		if p.calls == nil {
			p.calls = map[string]map[string]pendingTool{}
		}
		cs := p.calls[sessionID]
		if cs == nil {
			cs = map[string]pendingTool{}
			p.calls[sessionID] = cs
		}
		if len(cs) >= maxCallsPerSession { // a session that never reports its calls finishing: the oldest go
			oldest, at := "", time.Time{}
			for id, c := range cs {
				if oldest == "" || c.At.Before(at) {
					oldest, at = id, c.At
				}
			}
			delete(cs, oldest)
		}
		cs[t.ToolUseID] = pendingTool{ToolUseID: t.ToolUseID, ToolName: t.ToolName, At: t.At}
	}
}

// callDone drops a finished call; with no id, all of the session's calls (a turn's end, a new turn).
func (p *pendingTools) callDone(sessionID, toolUseID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if toolUseID == "" {
		delete(p.calls, sessionID)
		return
	}
	delete(p.calls[sessionID], toolUseID)
}

// callsFor are the ids of the session's calls of tool still in flight that started within maxAge: the calls a permission request for tool may be about.
func (p *pendingTools) callsFor(sessionID, tool string, now time.Time, maxAge time.Duration) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var ids []string
	for id, c := range p.calls[sessionID] {
		if c.ToolName == tool && !c.At.IsZero() && now.Sub(c.At) <= maxAge {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (p *pendingTools) get(sessionID string, now time.Time) (pendingTool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	t, ok := p.m[sessionID]
	if ok && now.Sub(t.At) > pendingToolTTL {
		delete(p.m, sessionID)
		return pendingTool{}, false
	}
	return t, ok
}

// prune drops the pending tool of every session isLive refuses, and any older than pendingToolTTL, and returns how many it
// dropped (#4602, L6: a session that ended with a prompt open left its entry for ever).
func (p *pendingTools) prune(isLive func(sessionID string) bool, now time.Time) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for id, t := range p.m {
		if !isLive(id) || now.Sub(t.At) > pendingToolTTL {
			delete(p.m, id)
			n++
		}
	}
	return n
}

// durationMs returns the server-observed duration of a matching tool call.
// Some agents report duration_ms themselves; Codex currently does not, so its
// PreToolUse and PostToolUse hook arrival times provide the fallback.
func (p *pendingTools) durationMs(sessionID, toolUseID string, now time.Time) (int64, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	t, ok := p.m[sessionID]
	if !ok || t.At.IsZero() || now.Before(t.At) || now.Sub(t.At) > pendingToolTTL {
		return 0, false
	}
	if toolUseID != "" && t.ToolUseID != "" && toolUseID != t.ToolUseID {
		return 0, false
	}
	ms := now.Sub(t.At).Milliseconds()
	if ms < 1 {
		ms = 1
	}
	return ms, true
}

// clear drops the pending tool for a session. With a tool_use_id, only that
// call is cleared (a newer call that started meanwhile stays).
func (p *pendingTools) clear(sessionID, toolUseID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if t, ok := p.m[sessionID]; ok && (toolUseID == "" || t.ToolUseID == toolUseID) {
		delete(p.m, sessionID)
	}
}

// Only the fields the chat shows are kept, each capped, so a large Write or
// Edit payload is never held or served.
var pendingToolFields = map[string]int{
	"questions":    20000, // AskUserQuestion (serialized size cap)
	"plan":         20000, // ExitPlanMode
	"command":      4000,
	"CommandLine":  4000,
	"description":  500,
	"file_path":    1000,
	"TargetFile":   1000,
	"AbsolutePath": 1000,
	"path":         1000,
	"url":          2000,
	"query":        500,
	"pattern":      500,
	"prompt":       2000,
}

func trimPendingInput(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, limit := range pendingToolFields {
		v, ok := in[k]
		if !ok || v == nil {
			continue
		}
		switch s := v.(type) {
		case string:
			out[k] = truncateUTF8(s, limit)
		default:
			if b, err := json.Marshal(v); err == nil && len(b) <= limit {
				out[k] = v
			}
		}
	}
	if out["command"] == nil && out["CommandLine"] != nil {
		out["command"] = out["CommandLine"]
	}
	if out["file_path"] == nil {
		if out["TargetFile"] != nil {
			out["file_path"] = out["TargetFile"]
		} else if out["AbsolutePath"] != nil {
			out["file_path"] = out["AbsolutePath"]
		}
	}
	return out
}

func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…"
}

// SetPendingTool records a tool call that has started (PreToolUse hook).
// POST /api/sessions/live/{name}/pending-tool
func (h *SessionsHandler) SetPendingTool(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string         `json:"session_id"`
		ToolUseID string         `json:"tool_use_id"`
		ToolName  string         `json:"tool_name"`
		ToolInput map[string]any `json:"tool_input"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	// Only the agent's own hook may say which tool it is about to run (#3481, Backend's
	// finding, like POST .../events in part 1): the pending tool tells auto-accept what an
	// approval is for, and the gate when an agy prompt can be open. The session token
	// decides the session, in every mode.
	owner, hasToken := VerifiedSession(r.Context())
	if !hasToken {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session_token_required",
			"message": "The pending tool comes from the agent's own hooks, with its session token"})
		return
	}
	if body.SessionID != "" && body.SessionID != owner.SessionID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "identity_mismatch",
			"message": "An agent can set the pending tool only for its own session"})
		return
	}
	body.SessionID = owner.SessionID
	if body.ToolName == "" {
		errBadRequest(w, "tool_name is required")
		return
	}
	body.ToolName = truncateUTF8(body.ToolName, 200)
	body.ToolUseID = truncateUTF8(body.ToolUseID, 200)
	if why := h.patternKillRefusal(r.Context(), owner, body.ToolName, body.ToolInput); why != "" {
		// The command is not run, so it is not a pending tool. The hook turns this into the CLI's refusal; only the reason is logged, never the command.
		slog.Info("[guard] a command that stops processes by a pattern was refused", "session", owner.SessionName, "why", why)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "refuse": shellkill.Message(why)})
		return
	}
	h.hints.forget(body.SessionID) // a blocking tool may open a prompt: read the screen again
	t := pendingTool{
		ToolUseID: body.ToolUseID,
		ToolName:  body.ToolName,
		Input:     trimPendingInput(body.ToolInput),
		At:        time.Now(),
	}
	h.pending.set(body.SessionID, t)
	h.noteToolStart(r.Context(), body.SessionID, body.ToolName, body.ToolUseID, body.ToolInput)
	h.watchForPrompt(body.SessionID, owner.SessionName, t) // agy sends no hook for a permission prompt (#4819)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// notePendingToolEvent clears the pending tool when the event log shows it
// finished, or that the turn moved on.
func (h *SessionsHandler) notePendingToolEvent(sessionID, eventType, toolUseID string) {
	defer h.wakeCodexPermissionWatches(sessionID)
	if sessionID == "" {
		return
	}
	switch eventType { // the calls in flight, whichever the single slot below holds (#6687)
	case "tool_use":
		h.pending.callDone(sessionID, toolUseID)
	case "stop", "prompt_submit", "session_reset", "session_end":
		h.pending.callDone(sessionID, "")
	}
	switch eventType { // the session's own request: open from its PermissionRequest until the turn moves on (#11352)
	case "permission_request":
		h.pending.markRequest(sessionID, true)
	case "stop", "prompt_submit", "session_reset", "session_end", "request_resolved":
		h.pending.markRequest(sessionID, false)
	}
	// A PostToolUse for another tool than the pending one is a late one of an earlier call: the pending tool still runs, and whatever it waits on is
	// still open. It changes nothing (it would otherwise mark the session as waiting for nothing, and a prompt answer is refused, #5254).
	if eventType == "tool_use" && toolUseID != "" {
		if t, ok := h.pending.get(sessionID, time.Now()); ok && t.ToolUseID != "" && t.ToolUseID != toolUseID {
			return
		}
	}
	h.hints.note(sessionID, eventType)
	switch eventType {
	case "tool_use":
		if toolUseID != "" {
			h.pending.clear(sessionID, toolUseID)
		}
	case "stop", "prompt_submit", "session_reset", "session_end":
		h.pending.clear(sessionID, "")
	}
}

// noteToolStart records, when a call starts while the session has a permission request of its own open and the start says the request was answered, that it was resolved (#11352): the card and the
// Inbox row must not wait for a PostToolUse that comes minutes later with a long command. Claude's only. Whether a start answers a request is the state derivation's own rule (Security's #136728):
// the call the request waits for starts; a call that began half a minute or more after the request; or, for a request whose call was not known, a start of the same tool with the same input as the
// request's wants (checked here, and written as same_input). The candidate event is derived first, and only one that closes the request is written: the PreToolUse of every other call writes nothing.
func (h *SessionsHandler) noteToolStart(ctx context.Context, sessionID, toolName, toolUseID string, input map[string]any) {
	if sessionID == "" || toolUseID == "" || h.ts == nil || h.ss == nil || !h.pending.requestIsOpen(sessionID) {
		return
	}
	ls, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || ls == nil || ls.AgentType != at.Claude {
		return
	}
	events, err := h.ts.GetSessionStateEvents(ctx, []string{sessionID})
	if err != nil {
		return
	}
	var in sessionstate.Input
	for _, ev := range events[sessionID] {
		in.Events = append(in.Events, ev.StateEvent())
	}
	st := sessionstate.Derive(in)
	if !st.NeedsInput {
		h.pending.markRequest(sessionID, false) // nothing is open any more: the marker was stale
		return
	}
	same := startMatchesWants(toolName, input, st.WaitingWants)
	candidate := sessionstate.Event{Type: "request_resolved", ToolName: toolName, ToolUseID: toolUseID, SameInput: same, At: time.Now()}
	in.Events = append(in.Events, candidate)
	if sessionstate.Derive(in).NeedsInput {
		return // this start does not answer it: a sibling, or another call's
	}
	id, sid := toolUseID, sessionID
	detail := `{"same_input":false}`
	if same {
		detail = `{"same_input":true}`
	}
	ev := &store.AgentEvent{AgentName: ls.AgentName, SessionID: &sid, EventType: "request_resolved", Summary: "A call started: the permission was given", DetailJSON: &detail, RefID: &id}
	if toolName != "" {
		ev.ToolName = &toolName
	}
	if _, err := h.ts.InsertAgentEvent(ctx, ev); err != nil {
		slog.Warn("could not record that a permission request was resolved by a call's start", "session_id", sessionID, "error", err)
		return
	}
	h.pending.markRequest(sessionID, false)
	h.kickFeedForRequestChange(sessionID, "request_resolved")
}

// startMatchesWants reports whether a call that starts (its tool and input) is what an open request's wants names: a Bash command whose "Wants to run: <command>" line, made as the hook makes it and
// stored as the server stores it, is the request's own. Any other tool, an input without a command, or no wants is not a match: such a request stays open until it is answered or dismissed.
func startMatchesWants(tool string, input map[string]any, wants string) bool {
	if tool != "Bash" || wants == "" {
		return false
	}
	cmd, _ := input["command"].(string)
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return false
	}
	if len(cmd) > 1<<10 { // the hook cuts one input to 1 KiB before the server cleans it
		cmd = cmd[:1<<10]
	}
	line, _ := waitingLine("Wants to run: " + strings.ToValidUTF8(cmd, "")).(string)
	return line != "" && line == wants
}

// requestCallMaxAge is how recent a call's PreToolUse must be for a permission request to be about it.
const requestCallMaxAge = 2 * time.Minute

// maxRequestCalls bounds the calls one request waits for.
const maxRequestCalls = 8

// tieRequestToItsCall puts into a permission request's detail the ids of the calls it may be about (call_ids, #6687). The PermissionRequest hooks (Claude's, Codex's) carry no tool_use_id, but the
// calls' PreToolUse come first: the session's calls of the request's tool still in flight and under two minutes old are the candidates. One candidate is the call; several (parallel calls of the
// same tool, only one of which waits) are all of them, and the request is then answered only when EVERY one of them has finished, never by the first, so no call's PostToolUse can close it early.
// Whatever the agent put in the detail is dropped: only the server's own record names the calls. None in flight: no ids, and the request is answered by its tool's name, as before.
func (h *SessionsHandler) tieRequestToItsCall(sessionID, tool string, detail any) any {
	d, ok := detail.(map[string]any)
	if !ok {
		if detail != nil {
			return detail
		}
		d = map[string]any{}
	}
	delete(d, "tool_use_id")
	delete(d, "call_ids")
	if sessionID != "" && tool != "" {
		if ids := h.pending.callsFor(sessionID, tool, time.Now(), requestCallMaxAge); len(ids) > 0 && len(ids) <= maxRequestCalls {
			d["call_ids"] = ids
		}
	}
	if len(d) == 0 {
		return nil
	}
	return d
}

// patternKillRefusal is why a Claude agent's Bash command is refused: it stops processes by a name or a pattern (pkill, killall, a kill fed by pgrep), which also ends other agents whose launch
// prompt, held in their command line, matches (#11157). "" lets it run: another tool or agent, the check turned off (refuse_pattern_kill), or a command that stops nothing by a pattern.
func (h *SessionsHandler) patternKillRefusal(ctx context.Context, owner *store.SessionTokenOwner, tool string, input map[string]any) string {
	// Everything that is cheap and decides whether to read the command at all comes first (Security's #11157 MUST): an agent that is not Claude, a tool that is not Bash and the check being off never
	// make the server parse a command an agent wrote.
	if tool != "Bash" || input == nil {
		return ""
	}
	command, _ := input["command"].(string)
	if command == "" {
		return ""
	}
	if s, err := h.ss.GetSettings(ctx); err == nil && !setreg.Bool(s, setreg.RefusePatternKill) {
		return ""
	}
	if ls, err := h.ss.GetLiveSession(ctx, owner.SessionID); err != nil || ls == nil || ls.AgentType != at.Claude {
		return "" // the refusal is the Claude CLI's hook answer
	}
	return shellkill.PatternKill(command) // bounded: a command past a bound runs
}
