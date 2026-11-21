package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// A custom health check's run token (#20138, design v2 section 4, Security's conditions on #20135). It acts as the member who added the check, so the same identity checks apply as for that member's own
// token, and on top of them the request must be on a default-deny allow list: reads, and with the Operator's "may write" tick a post to the board, a task, a comment on a task and a reassignment, each
// with only the fields listed here. Nothing that creates a Needs you item (post --ask, an @Operator mention, a "for review" upload), nothing that touches a terminal, a task's outcome, settings, members,
// grants, checks or tokens is on it: a route that is not listed is refused, whatever the member could do.

const bp = "/api/board/{project}"

// checkReadRoutes are what a check may read (method and the router's pattern). GET .../messages is not here: reading it moves the member's own read cursor.
var checkReadRoutes = map[string]bool{
	"GET " + bp + "/messages/check":         true,
	"GET " + bp + "/messages/search":        true,
	"GET " + bp + "/subscribers":            true,
	"GET " + bp + "/tasks":                  true,
	"GET " + bp + "/tasks/{taskID}":         true,
	"GET " + bp + "/tasks/{taskID}/history": true,
	"GET /api/agent/tasks":                  true,
	"GET /api/agent/tasks/{taskID}":         true,
}

// checkWriteRoutes are what a check with the "may write" tick may do, and the body fields each takes: any other field is refused (a field is what turns a post into a question, a task into a forced
// assignment, a reply into an answer to the Operator). text names the fields the server marks "[via check <name>]".
var checkWriteRoutes = map[string]struct{ fields, text []string }{
	"POST " + bp + "/messages":                {fields: []string{"subscriber_id", "content", "task_id"}, text: []string{"content"}},
	"POST " + bp + "/tasks":                   {fields: []string{"title", "body", "priority", "subscriber_id", "created_by", "assigned_to"}, text: []string{"title", "body"}},
	"POST " + bp + "/tasks/{taskID}/reply":    {fields: []string{"content", "reply_to"}, text: []string{"content"}},
	"POST " + bp + "/tasks/{taskID}/reassign": {fields: []string{"subscriber_id", "assignee"}, text: nil},
}

// CheckAllowedRoutes lists the allow list, for the census test.
func CheckAllowedRoutes() (reads, writes []string) {
	for k := range checkReadRoutes {
		reads = append(reads, k)
	}
	for k := range checkWriteRoutes {
		writes = append(writes, k)
	}
	return
}

// viaCheckMark is the server's own prefix on every text a check writes: it names the check, and nothing a script prints can replace it.
func viaCheckMark(check string) string { return "[via check " + check + "] " }

// routePattern is the router's pattern for the request and the {project} it matched ("" when the route has none).
func routePattern(r *http.Request) (pattern, project string) {
	rc := chi.RouteContext(r.Context())
	if rc == nil || rc.Routes == nil {
		return "", ""
	}
	t := chi.NewRouteContext()
	if !rc.Routes.Match(t, r.Method, routedPath(r)) {
		return "", ""
	}
	return t.RoutePattern(), t.URLParam("project")
}

// forwardedHeaders are the ones a proxy adds: a request that has any came from somewhere else.
var forwardedHeaders = []string{"X-Forwarded-For", "Forwarded", "X-Real-Ip", "X-Forwarded-Host"}

// fromLoopback says the connection itself came from this computer and no proxy stands in front of it. The token is the credential that is checked next, so this is the loopback pass (auth.IsDirectLocalPeer), not a
// local-power decision; the extra headers are refused too.
func fromLoopback(r *http.Request) bool {
	for _, h := range forwardedHeaders {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	return auth.IsDirectLocalPeer(r)
}

var viaCheckRE = regexp.MustCompile(`(?i)\[via check`)
var broadcastRE = regexp.MustCompile(`(?i)@(all|everyone|notify-all|notify_all|notifyall)\b`)

// checkTokenGate admits or refuses a request that carries a check token. ok false means the response is written. On ok, via says who the token stands for, and r is the request with its text marked.
func (o *IdentityObserver) checkTokenGate(w http.ResponseWriter, r *http.Request, token string) (via *store.CheckTokenOwner, out *http.Request, ok bool) {
	// Loopback only: a tunneled request (any Via stamp, even an unverified one) never carries a check token, and never both kinds of token.
	if r.Header.Get(tunnel.ViaHeader) != "" || r.Header.Get(store.SessionTokenHeader) != "" || !fromLoopback(r) {
		o.refuse(w, http.StatusForbidden, "check_token_refused", "A check's token is for this computer only, and never on a request that also carries an agent's token")
		return nil, r, false
	}
	now := time.Now()
	v, err := o.db.CheckTokenOf(r.Context(), token, now)
	if err != nil {
		o.refuse(w, http.StatusUnauthorized, "check_token_invalid", "This check's token is unknown, or its run has ended")
		return nil, r, false
	}
	pattern, project := routePattern(r)
	if project != "" && project != v.Project { // the check's own board and no other, even for a member seated on two
		o.refuse(w, http.StatusForbidden, "check_token_denied", "A check's token is for the board it was added on")
		return nil, r, false
	}
	key := r.Method + " " + pattern
	if checkReadRoutes[key] {
		return v, r, true
	}
	spec, isWrite := checkWriteRoutes[key]
	if !isWrite {
		o.refuse(w, http.StatusForbidden, "check_token_denied", "A check's token may read the board's tasks and members and search messages, and with the Operator's 'may write' tick post, add a task, comment on a task and reassign one: not "+r.Method+" "+r.URL.Path)
		return nil, r, false
	}
	if !v.MayWrite {
		o.refuse(w, http.StatusForbidden, "check_token_read_only", "This check may only read: the Operator has not ticked 'may write' for it")
		return nil, r, false
	}
	out, why := o.markViaCheck(r, v.Project, v.Check, spec.fields, spec.text)
	if why != "" {
		o.refuse(w, http.StatusForbidden, "check_token_denied", why)
		return nil, r, false
	}
	if allowed, err := o.db.TakeCheckWrite(r.Context(), token, now); err != nil || !allowed {
		code := http.StatusTooManyRequests
		if err != nil {
			code = http.StatusServiceUnavailable
		} else {
			w.Header().Set(httputil.ActionLimitHeader, "action") // a limit on this check's writes, not a busy server: the dashboard must not pause its pollers
		}
		o.refuse(w, code, "check_write_limit", "A check may write "+strconv.Itoa(store.CheckWritesPerRun)+" times a run and "+strconv.Itoa(store.CheckWritesPerHour)+" times an hour")
		return nil, r, false
	}
	return v, out, true
}

// markViaCheck reads the body, refuses a field that is not listed or an @Operator mention, cleans and redacts each text and puts the server's mark in front of it, and returns the request with that body.
// why is the refusal in words, "" when the body is fine.
func (o *IdentityObserver) markViaCheck(r *http.Request, project, check string, fields, text []string) (*http.Request, string) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return r, "the request body could not be read"
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return r, "a check's write is a JSON object"
	}
	allowed := map[string]bool{}
	for _, f := range fields {
		allowed[f] = true
	}
	for k := range m {
		if !allowed[k] {
			return r, "a check's write may not carry the field " + k + " (it may carry " + strings.Join(fields, ", ") + ")"
		}
	}
	for _, f := range []string{"assigned_to", "assignee"} { // an assignment posts a notice, and the Operator's would be a Needs you item: only a member of this board, never the Operator
		if v, present := m[f]; present {
			name, isText := v.(string)
			name = strings.TrimSpace(name)
			if !isText {
				return r, "the field " + f + " is a member's name"
			}
			if name == "" {
				continue
			}
			if board.SameIdentity(name, board.OperatorName) {
				return r, "a check may not give the Operator work: that would put an item in Needs you"
			}
			if sub, err := o.bs.GetProjectSubscription(r.Context(), project, name); err != nil || sub == nil {
				return r, f + " must be a member of this board"
			}
		}
	}
	for _, f := range text {
		v, ok := m[f].(string)
		if !ok {
			if _, present := m[f]; present {
				return r, "the field " + f + " is text"
			}
			continue
		}
		clean := viaCheckRE.ReplaceAllString(clitext.Clean(v), "(via check")
		if strings.Contains(strings.ToLower(clean), "@operator") || broadcastRE.MatchString(clean) {
			return r, "a check may not mention the Operator or everyone: that would put an item in Needs you or wake the whole team"
		}
		red, rerr := secrets.Redactor().Text([]byte(clean))
		if rerr != nil {
			return r, "Coral could not check the text for secrets just now"
		}
		m[f] = viaCheckMark(check) + string(red)
	}
	body, _ := json.Marshal(m)
	r2 := r.Clone(r.Context())
	r2.Body = io.NopCloser(bytes.NewReader(body))
	r2.ContentLength = int64(len(body))
	r2.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return r2, ""
}
