package routes

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/permreview"
)

// An opencode agent launched "ask first" (permission mode Default) has its server ask before an edit and before a command (#11395). The server says so on its event stream, Coral keeps the open requests
// (opencode.Manager.AgentPermissions) and shows each as the same card Claude's permission prompts get (the chat's "pending" and "prompt_options"), and the answer goes back through the SAME server: no keys are typed
// into the terminal. Any other mode leaves opencode's own defaults, which ask for nothing inside the folder.

// opencodeAsks says a launch in this permission mode starts opencode ask first: only Default. Bypass, Auto and Don't ask leave opencode's own defaults.
func opencodeAsks(mode string) bool { return mode == "default" }

// opencodeOption is one answer on a card: its words and what it tells the server.
type opencodeOption struct{ Label, Reply string }

// opencodeCardOptions are a request's answers, in order. A request that could be shown whole and holds nothing hidden (permreview) gets Allow once (the default), Allow always (worded with what it stops asking
// about) and Reject; one that could not gets Reject ALONE: the server refuses an Allow for it too. The card and the answer both take their options from here, so what is drawn is what is accepted.
func opencodeCardOptions(p opencode.PermissionRequest) []opencodeOption {
	if !p.Allowed() {
		return []opencodeOption{{"Reject", "reject"}}
	}
	always := "Allow always"
	if len(p.Always) > 0 {
		scope := strings.Join(p.Always, ", ")
		if more := permreview.MoreNote(p.MoreAlways); more != "" {
			scope += " " + more
		}
		always = "Allow always: do not ask again for " + scope
	}
	return []opencodeOption{{"Allow once", "once"}, {always, "always"}, {"Reject", "reject"}}
}

// opencodeNeedsInput puts an agent's newest open permission request in a chat reply as the card the person answers: pending (the tool and the whole request, up to permreview.MaxBytes, for a scrolling box, with
// the sentence that says so when it cannot be allowed) and prompt_options (the question and the answers, its ask id the request's id). With none open, pending is null and there are no options.
func (h *SessionsHandler) opencodeNeedsInput(reply map[string]any, sessionID string) {
	reply["pending"] = nil
	if h.opencode == nil {
		return
	}
	reqs := h.opencode.AgentPermissions(sessionID)
	if len(reqs) == 0 {
		return
	}
	p := reqs[0]
	input := map[string]any{}
	if p.Command != "" {
		input["command"] = p.Command
	}
	if p.File != "" {
		input["file_path"] = p.File
	}
	if len(p.Patterns) > 0 {
		input["patterns"] = p.Patterns
	}
	if more := permreview.MoreNote(p.MorePatterns); more != "" {
		input["more_patterns"] = more
	}
	if !p.Allowed() {
		input["only_reject"] = true
		input["note"] = permreview.Merge(permreview.Review{Cut: p.Cut, Hidden: p.Hidden}).Note()
	}
	reply["pending"] = pendingTool{ToolUseID: p.ID, ToolName: p.Permission, Input: input, At: p.At}
	choices := opencodeCardOptions(p)
	opts := make([]promptOption, len(choices))
	for i, o := range choices {
		opts[i] = promptOption{N: i + 1, Label: o.Label, Selected: i == 0, Action: "select"}
	}
	reply["prompt_options"] = promptScreen{Question: opencodeQuestion(p), Options: opts, AskID: p.ID}
}

// opencodeQuestion is what the card asks: what opencode wants to do, in Coral's words (never the server's text as a sentence: the command or the file is quoted).
func opencodeQuestion(p opencode.PermissionRequest) string {
	switch {
	case p.Permission == "bash" && p.Command != "":
		return "opencode wants to run: " + p.Command
	case p.Permission == "edit" && p.File != "":
		return "opencode wants to edit " + p.File
	case p.Permission == "external_directory":
		return "opencode wants to use a folder outside its own: " + strings.Join(p.Patterns, ", ")
	case p.Permission != "":
		return "opencode asks to allow: " + p.Permission
	}
	return "opencode asks to allow an action"
}

// answerOpencodePermission is the answer to an opencode agent's card: the request it was drawn for (the ask id) must still be open on that agent's server, the label must be the one of that option, and the answer
// is sent to the server. It answers the request's id from the SERVER's own list, never an id only the caller names.
func (h *SessionsHandler) answerOpencodePermission(w http.ResponseWriter, r *http.Request, sessionID string, n int, label, askID string) {
	if askID == "" {
		errBadRequest(w, "ask_id is required to answer opencode")
		return
	}
	if h.opencode == nil {
		errConflict(w, "The prompt is no longer open. Check the terminal.")
		return
	}
	var req *opencode.PermissionRequest
	for _, p := range h.opencode.AgentPermissions(sessionID) {
		if p.ID == askID {
			p := p
			req = &p
			break
		}
	}
	if req == nil {
		writeError(w, http.StatusConflict, "ask_changed", "That question changed; look at it again.")
		return
	}
	choices := opencodeCardOptions(*req) // the answers THIS request was drawn with: a request that can only be rejected has one
	if n < 1 || n > len(choices) || normalizeLabel(choices[n-1].Label) != normalizeLabel(label) {
		errConflict(w, "The prompt changed. Answer it in the terminal.")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 15*time.Second)
	defer cancel()
	if err := h.opencode.ReplyPermission(ctx, sessionID, askID, choices[n-1].Reply); err != nil {
		if errors.Is(err, opencode.ErrPermissionGone) {
			errConflict(w, "The prompt is no longer open. Check the terminal.")
			return
		}
		if errors.Is(err, opencode.ErrPermissionRefused) {
			errConflict(w, "That request can only be rejected here. Read it in the terminal.")
			return
		}
		writeError(w, http.StatusBadGateway, "", "opencode could not take the answer. Answer it in the terminal.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "answered": choices[n-1].Label})
}
