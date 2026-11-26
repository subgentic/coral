package routes

import (
	"context"
	"encoding/json"
	"github.com/subgentic/coral/internal/board"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// An automation's post (#21502): a shell step of a workflow whose board is set posts to that board as "Automation: NAME". Its credential is a run token (store.AutomationTokenHeader), minted for one run, bound to
// the run, the workflow and its board, valid on this computer's loopback only, and good for exactly one route: POST /api/board/{project}/automation/post, a post of text and nothing else. The sender and the mark
// are written by the server from the token; no field of the request names either. Everything else the token is sent to is refused.

// AutomationPostRoute is the one route an automation token may use (the router's pattern), for the census test.
const AutomationPostRoute = "POST " + bp + "/automation/post"

type automationKey struct{}

// automationOwner is the run an automation token stands for on this request, nil when the request carries none.
func automationOwner(ctx context.Context) *store.AutomationTokenOwner {
	o, _ := ctx.Value(automationKey{}).(*store.AutomationTokenOwner)
	return o
}

var viaAutomationRE = regexp.MustCompile(`(?i)\[via\s+automation`)

// viaAutomationMark is the server's prefix on the text of every automation post: it names the workflow, and nothing a script prints can replace it.
func viaAutomationMark(name string) string {
	return "[via automation " + board.DefuseMentions(name, nil) + "] " // the name is put in after the mention checks: an @ in it must notify nobody (Security, #21502 point 6)
}

// automationTokenGate admits or refuses a request that carries an automation token. ok false means the response is written. On ok, the request carries the run the token stands for.
func (o *IdentityObserver) automationTokenGate(w http.ResponseWriter, r *http.Request, token string) (*http.Request, bool) {
	// Loopback only, never with another credential: no Hub tunnel stamp, no agent's token, no check's token, no command-line signature, no proxy header.
	if r.Header.Get(tunnel.ViaHeader) != "" || r.Header.Get(store.SessionTokenHeader) != "" || r.Header.Get(store.CheckTokenHeader) != "" || r.Header.Get(cliauth.CLIAuthHeader) != "" || !fromLoopback(r) {
		o.refuse(w, http.StatusForbidden, "automation_token_refused", "An automation's token is for a step on this computer, and never on a request that carries another credential")
		return r, false
	}
	now := time.Now()
	v, err := o.db.AutomationTokenOf(r.Context(), token, now)
	if err != nil {
		o.refuse(w, http.StatusUnauthorized, "automation_token_invalid", "This automation's token is unknown, or its run has ended")
		return r, false
	}
	pattern, project := routePattern(r)
	if r.Method+" "+pattern != AutomationPostRoute {
		o.refuse(w, http.StatusForbidden, "automation_token_denied", "An automation's token may post to its own team and nothing else: not "+r.Method+" "+r.URL.Path)
		return r, false
	}
	if project != v.Project { // its workflow's board and no other
		o.refuse(w, http.StatusForbidden, "automation_token_denied", "An automation's token is for the team its workflow is set to post to")
		return r, false
	}
	if allowed, err := o.db.TakeAutomationWrite(r.Context(), token, now); err != nil || !allowed {
		code := http.StatusTooManyRequests
		if err != nil {
			code = http.StatusServiceUnavailable
		} else {
			w.Header().Set(httputil.ActionLimitHeader, "action") // a limit on one action, not an overloaded server: the dashboard keeps polling
		}
		o.refuse(w, code, "automation_write_limit", "An automation may post "+strconv.Itoa(store.AutomationWritesPerRun)+" times a run and "+strconv.Itoa(store.AutomationWritesPerHour)+" times an hour")
		return r, false
	}
	return r.WithContext(context.WithValue(r.Context(), automationKey{}, v)), true
}

// PostAutomation answers POST /api/board/{project}/automation/post {"content": "..."}: the post of an automation's step. Only a request the observer admitted with an automation token reaches it; any other caller
// (the Operator, an agent, a guide) is refused, so this route is no way to post as an automation.
func (h *BoardHandler) PostAutomation(w http.ResponseWriter, r *http.Request) {
	owner := automationOwner(r.Context())
	project := urlParam(r, "project")
	if owner == nil || owner.Project != project {
		writeError(w, http.StatusForbidden, "automation_only", "This route is for the posts of an automation's step, with its run's token")
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBoardBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || dec.More() { // one object, the one field: nothing after it is read as anything
		errBadRequest(w, "an automation's post is one JSON object with content and nothing else")
		return
	}
	text := strings.TrimSpace(clitext.Clean(unescapeLineBreaks(body.Content)))
	if text == "" {
		errBadRequest(w, "content required")
		return
	}
	if len(text) > maxBoardPostContent {
		errBadRequest(w, "a board post is at most "+strconv.Itoa(maxBoardPostContent>>10)+" KiB: put the long text in an artifact and post its link")
		return
	}
	if why := clitext.WordlessMessage(text); why != "" {
		errBadRequest(w, why)
		return
	}
	lower := strings.ToLower(text)
	if strings.Contains(lower, "@operator") || broadcastRE.MatchString(text) { // that would put an item in Needs you or wake the whole team
		writeError(w, http.StatusBadRequest, "automation_mention_refused", "an automation may not mention the Operator or everyone: mention an agent of the team by name")
		return
	}
	if h.bs.StaysDeleted(r.Context(), project) {
		writeError(w, http.StatusNotFound, "board_deleted", "this team was deleted")
		return
	}
	text = viaAutomationRE.ReplaceAllString(text, "(via automation")
	text = h.useBoardIDs(r.Context(), project, text)
	if problems := h.bs.UnknownMentions(r.Context(), project, text); len(problems) > 0 {
		msg := "not posted: " + strings.Join(problems, "; ") + ". Mention a member of this team, or take the @ out of the text"
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": msg, "message": msg, "code": "unknown_mention", "mentions": problems, "not_sent": true})
		return
	}
	red, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "redaction_unavailable", "Coral could not check the text for secrets just now")
		return
	}
	msg, err := h.bs.PostAutomationMessage(r.Context(), project, owner.WorkflowName, viaAutomationMark(strings.Join(strings.Fields(owner.WorkflowName), " "))+string(red))
	if err != nil {
		errInternalServer(w, "could not post")
		return
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": msg.ID, "sender": msg.SubscriberID, "notified": h.bs.NotifiedBy(r.Context(), project, msg.SubscriberID, msg.Content)})
}
