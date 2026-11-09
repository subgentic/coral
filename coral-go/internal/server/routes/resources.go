package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

// The resource queue (#13613, goal #225): resources with slots that agents claim, wait for and release. One server's; the ids may carry a server later (hub-wide).
//
//	GET    /api/resources                       every resource: slots, holders, the line in order
//	GET    /api/resources/{name}                one
//	POST   /api/resources/{name}/claim          {subscriber_id, note}   a slot, or a place in line
//	POST   /api/resources/{name}/release        {subscriber_id}         give it up, or leave the line
//	POST   /api/resources/{name}/renew          {subscriber_id}         a full lease from now
//	PUT    /api/resources/{name}                {slots, machine, max_lease_seconds, allowed}   define or change (the Operator or an Orchestrator)
//	DELETE /api/resources/{name}                                                                remove (the Operator or an Orchestrator)
//	POST   /api/resources/entries/{id}/move     {how: first|up|down}    reorder the line (the Operator or an Orchestrator)
//	DELETE /api/resources/entries/{id}                                  kick a holder or drop an entry (the Operator or an Orchestrator)
//
// A claim is ranked by the claimer's own task (internal/resources), and the claimer is the verified caller, not what the body says (attributedTo).
type ResourcesHandler struct {
	M     *resources.Manager
	Board *board.Store
	Watch *resources.Watcher // a holder stuck at a prompt or idle (#13705); may be nil
	Hook  *resources.Hook    // the shell hook, swept with every call (#13645); may be nil
	// ToolCalls are the tool_use ids of the calls the session has in flight (the one running coral-board resource claim is among them; tools run in parallel); none when not known: a claim then keeps its lease (#13718); nil: hand claims are not tied to a call.
	ToolCalls func(sessionID string) []string
	// AgentPID is the process of the agent itself (its session's), 0 when not known: a shell that IS the agent (a simple command a shell ran directly leaves the agent as the claim's parent) says nothing about the job, so such a claim follows its call alone (#13718).
	AgentPID func(sessionName string) int
}

type entryView struct {
	ID        int64  `json:"id"`
	Agent     string `json:"agent"`
	Task      int    `json:"task,omitempty"`
	Project   string `json:"project,omitempty"` // the task's board (#13704)
	GoalID    int64  `json:"goal_id,omitempty"` // the task's goal, read from the board with the list (#13704)
	GoalTitle string `json:"goal_title,omitempty"`
	Priority  int    `json:"priority"`
	Note      string `json:"note,omitempty"`
	Enqueued  string `json:"enqueued_at"`
	Granted   string `json:"granted_at,omitempty"`
	Lease     string `json:"lease_until,omitempty"`
	Pinned    bool   `json:"pinned,omitempty"`
	Place     int    `json:"place,omitempty"`
	Stuck     string `json:"stuck,omitempty"`     // "prompt" or "idle" once the holder has been told of (#13705)
	StuckMin  int    `json:"stuck_min,omitempty"` // how long, in minutes
	IdleMin   *int   `json:"idle_min,omitempty"`  // #14079: minutes with nothing running under the claim (0 is shown too); absent: working, or not a claim Coral can look at
	Member    string `json:"member,omitempty"`    // a pool's hold: the member it was granted (#13719)
	Machine   string `json:"machine,omitempty"`   // and that member's machine, for people to read
	// What the run is (#14857): the command the agent said it runs, the commit, the minutes it expects and, once it records them, its exit code and last line. Text for people to read, never run.
	Cmd       string `json:"cmd,omitempty"`
	Head      string `json:"head,omitempty"`
	ExpectMin int    `json:"expect_min,omitempty"`
	Exit      *int   `json:"exit,omitempty"`
	Line      string `json:"line,omitempty"`
}

// resourceRunView is one finished run of a resource (#14857): the last resourcequeue.HistoryKeep, newest first.
type resourceRunView struct {
	ID       int64  `json:"id"`
	Agent    string `json:"agent"`
	Task     int    `json:"task,omitempty"`
	Project  string `json:"project,omitempty"`
	Note     string `json:"note,omitempty"`
	Cmd      string `json:"cmd,omitempty"`
	Head     string `json:"head,omitempty"`
	Machine  string `json:"machine,omitempty"`
	Granted  string `json:"granted_at"`
	Released string `json:"released_at"`
	How      string `json:"how"`
	Exit     *int   `json:"exit,omitempty"`
	Line     string `json:"line,omitempty"`
	TookS    int64  `json:"took_s"`
}

type resourceView struct {
	Name     string            `json:"name"`
	Slots    int               `json:"slots"`
	Machine  string            `json:"machine,omitempty"`
	MaxLease int               `json:"max_lease_seconds"`
	Members  []string          `json:"members,omitempty"` // a pool: its members, in the order they are tried
	Allowed  []string          `json:"allowed,omitempty"`
	Match    []string          `json:"match,omitempty"`
	Holders  []entryView       `json:"holders"`
	Queue    []entryView       `json:"queue"`
	History  []resourceRunView `json:"history"` // the last finished runs, newest first (#14857)
}

func viewEntry(e resourcequeue.Entry, place int) entryView {
	v := entryView{ID: e.ID, Agent: e.Agent, Task: e.Task, Project: e.Project, Priority: e.Priority, Note: e.Note, Enqueued: e.Enqueued.UTC().Format(time.RFC3339), Member: e.Member, Pinned: e.Pin > 0, Place: place, Cmd: e.Cmd, Head: e.Head, ExpectMin: e.ExpectMin, Exit: e.Exit, Line: e.Line}
	if !e.Granted.IsZero() {
		v.Granted = e.Granted.UTC().Format(time.RFC3339)
		v.Lease = e.Lease.UTC().Format(time.RFC3339)
	}
	return v
}

func viewStatus(st resourcequeue.Status) resourceView {
	lease := st.Resource.MaxLease
	if lease <= 0 {
		lease = resourcequeue.DefaultLease
	}
	v := resourceView{Name: st.Resource.Key, Slots: st.Resource.Slots, Machine: st.Resource.Machine, MaxLease: int(lease / time.Second), Members: st.Resource.Members, Allowed: st.Resource.Allowed, Match: st.Resource.Match, Holders: []entryView{}, Queue: []entryView{}}
	for _, e := range st.Holders {
		v.Holders = append(v.Holders, viewEntry(e, 0))
	}
	for i, e := range st.Queue {
		v.Queue = append(v.Queue, viewEntry(e, i+1))
	}
	v.History = []resourceRunView{}
	for _, r := range st.History {
		v.History = append(v.History, resourceRunView{ID: r.ID, Agent: r.Agent, Task: r.Task, Project: r.Project, Note: r.Note, Cmd: r.Cmd, Head: r.Head, Machine: r.Machine,
			Granted: r.Granted.UTC().Format(time.RFC3339), Released: r.Released.UTC().Format(time.RFC3339), How: r.How, Exit: r.Exit, Line: r.Line, TookS: r.TookS})
	}
	return v
}

func (h *ResourcesHandler) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, resourcequeue.ErrNoResource), errors.Is(err, resourcequeue.ErrNoEntry):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, resourcequeue.ErrNotAllowed):
		writeError(w, http.StatusForbidden, "not_allowed", err.Error())
	case errors.Is(err, resourcequeue.ErrQueueFull):
		writeError(w, http.StatusConflict, "queue_full", err.Error())
	case errors.Is(err, resourcequeue.ErrNotHolder):
		writeError(w, http.StatusConflict, "not_holder", err.Error())
	case errors.Is(err, resourcequeue.ErrInPool):
		writeError(w, http.StatusConflict, "in_pool", err.Error())
	case errors.Is(err, resourcequeue.ErrBadResource), errors.Is(err, resourcequeue.ErrBadMatch):
		errBadRequest(w, err.Error())
	default:
		errInternalServer(w, err.Error())
	}
}

// reap keeps the line honest on every call: leases that ran out end and agents that are gone are dropped before the answer is made.
func (h *ResourcesHandler) reap() {
	_, _ = h.M.Queue().Reap()
	h.Hook.Sweep() // the hook's claims that should end (a nil Hook does nothing)
}

// List answers GET /api/resources.
func (h *ResourcesHandler) List(w http.ResponseWriter, r *http.Request) {
	h.reap()
	out := []resourceView{}
	for _, st := range h.M.Queue().All() {
		out = append(out, viewStatus(st))
	}
	h.addGoals(r.Context(), out)
	h.addStuck(out)
	h.addMachines(out)
	writeJSON(w, http.StatusOK, map[string]any{"resources": out})
}

// addGoals gives each entry whose task has a goal that goal's id and title (#13704, the Queue folder links it): one lookup per board for every task on it, never one per row. A board that cannot be read leaves its entries without a goal: the line itself is unaffected.
func (h *ResourcesHandler) addGoals(ctx context.Context, views []resourceView) {
	if h.Board == nil {
		return
	}
	ids := map[string][]int64{}
	seen := map[string]bool{}
	each := func(f func(*entryView)) {
		for i := range views {
			for j := range views[i].Holders {
				f(&views[i].Holders[j])
			}
			for j := range views[i].Queue {
				f(&views[i].Queue[j])
			}
		}
	}
	each(func(e *entryView) {
		k := e.Project + "#" + strconv.Itoa(e.Task)
		if e.Project != "" && e.Task > 0 && !seen[k] {
			seen[k] = true
			ids[e.Project] = append(ids[e.Project], int64(e.Task))
		}
	})
	goals := map[string]map[int64]board.TaskGoalRef{}
	for project, list := range ids {
		if g, err := h.Board.TaskGoals(ctx, project, list); err == nil {
			goals[project] = g
		}
	}
	each(func(e *entryView) {
		if g, ok := goals[e.Project][int64(e.Task)]; ok && e.Project != "" {
			e.GoalID, e.GoalTitle = g.ID, g.Title
		}
	})
}

// addStuck marks the holders the watcher has told the Orchestrator of (#13705): the Queue folder shows them as Stuck.
func (h *ResourcesHandler) addStuck(views []resourceView) {
	for i := range views {
		for j := range views[i].Holders {
			e := &views[i].Holders[j]
			if d, ok := h.Hook.IdleFor(views[i].Name, e.Agent); ok {
				m := int(d / time.Minute)
				e.IdleMin = &m
			}
			if h.Watch == nil {
				continue
			}
			if info, ok := h.Watch.Stuck(e.ID); ok {
				e.Stuck, e.StuckMin = info.Kind, int(info.Age/time.Minute)
			}
		}
	}
}

// Get answers GET /api/resources/{name}.
func (h *ResourcesHandler) Get(w http.ResponseWriter, r *http.Request) {
	h.reap()
	st, err := h.M.Queue().Status(chi.URLParam(r, "name"))
	if err != nil {
		h.fail(w, err)
		return
	}
	one := []resourceView{viewStatus(st)}
	h.addStuck(one)
	h.addMachines(one) // a pool's holds say which machine they are on here too (#13751)
	writeJSON(w, http.StatusOK, one[0])
}

type agentBody struct {
	SubscriberID string `json:"subscriber_id"`
	Note         string `json:"note"`
	KeepPlace    bool   `json:"keep_place,omitempty"` // release: a wait that ended without a turn (the CLI's --timeout): the place in line is kept for a grace, not dropped (#13706)
	// What the run is (#14857), for the Operator's resource page: claim carries the command and the commit the agent says it runs and the minutes it expects; result carries the exit code and the last line. Text for
	// people to read, cleaned, redacted and cut here; nothing in it is ever run.
	Cmd       string `json:"cmd,omitempty"`
	Head      string `json:"head,omitempty"`
	ExpectMin int    `json:"expect_min,omitempty"`
	Exit      *int   `json:"exit,omitempty"`
	Line      string `json:"line,omitempty"`
	ParentPID int    `json:"parent_pid,omitempty"` // a claim by an agent: the shell that ran coral-board (a job in the background keeps the slot while it runs, #13718)
}

// agent reads the body and the verified name of the caller.
func (h *ResourcesHandler) agent(w http.ResponseWriter, r *http.Request) (agentBody, string, bool) {
	var body agentBody
	if err := decodeJSONMax(w, r, &body, 4096); err != nil {
		errBadRequest(w, "invalid JSON")
		return body, "", false
	}
	who, ok := attributedTo(w, r, body.SubscriberID)
	if !ok {
		return body, "", false
	}
	who = strings.TrimSpace(who)
	if who == "" {
		errBadRequest(w, "subscriber_id required")
		return body, "", false
	}
	return body, who, true
}

// Claim answers POST /api/resources/{name}/claim: 200 with granted true, or 202 with the place in line.
func (h *ResourcesHandler) Claim(w http.ResponseWriter, r *http.Request) {
	body, who, ok := h.agent(w, r)
	if !ok {
		return
	}
	h.reap()
	name := chi.URLParam(r, "name")
	res, err := h.M.ClaimPollingDetails(resources.WithSession(r.Context(), callerActor(r).Session), name, who, cleanText(body.Note, 200),
		resources.Details{Cmd: cleanRunText(body.Cmd, maxRunCmd), Head: cleanHead(body.Head), ExpectMin: cleanExpect(body.ExpectMin)})
	if err != nil {
		h.fail(w, err)
		return
	}
	if owner, ok := VerifiedSession(r.Context()); !ok || owner == nil {
		slog.Info("[resource] a claim with no verified session keeps its lease", "agent", who, "resource", name)
	} else if h.Hook != nil && h.ToolCalls != nil { // an agent's claim belongs to the tool call it is made in (#13718)
		var agentPID int
		if h.AgentPID != nil {
			agentPID = h.AgentPID(owner.SessionName)
		}
		calls := h.ToolCalls(owner.SessionID)
		slog.Info("[resource] a claim by an agent is tied to its tool call", "agent", who, "resource", name, "calls_known", len(calls), "shell_given", body.ParentPID > 1, "session", owner.SessionID)
		h.Hook.BindHand(owner.SessionID, who, name, calls, body.ParentPID, agentPID) // the hook believes the shell only when it is below the agent
	}
	code := http.StatusOK
	if !res.Granted {
		code = http.StatusAccepted
	}
	ev := viewEntry(res.Entry, res.Place)
	if ev.Member != "" {
		if ms, err := h.M.Queue().Status(ev.Member); err == nil {
			ev.Machine = ms.Resource.Machine // a pool's grant says which machine it is on
		}
	} else if ms, err := h.M.Queue().Status(name); err == nil {
		ev.Machine = ms.Resource.Machine // and a plain slot resource's grant says its own (#14262: a claim for the mini named no machine, and heavy run took it for the Mac)
	}
	writeJSON(w, code, map[string]any{"granted": res.Granted, "place": res.Place, "entry": ev})
}

// What the Operator's page shows of a run is text an agent wrote: cut here, and never run (#14857).
const (
	maxRunCmd  = 300 // the command
	maxRunLine = 200 // the last line of the result
	maxExpect  = 24 * 60
)

// envAssign is an environment assignment in a command (TOKEN=abc): its value is never kept, whatever it holds (no env values, #14857).
var envAssign = regexp.MustCompile(`\b([A-Z][A-Z0-9_]+)=\S+`)

// cleanRunText is text an agent gave about its run: control characters out, secrets redacted (the comments' redactor), the values of environment assignments hidden, cut to n characters. "" when the redactor cannot be
// trusted: a run shown with no command is better than one that leaks.
func cleanRunText(s string, n int) string {
	s = cleanText(s, 4*n)
	if s == "" {
		return ""
	}
	red, ok := redactComment(s)
	if !ok {
		return ""
	}
	return cleanText(envAssign.ReplaceAllString(red, "$1=…"), n)
}

// cleanHead is a commit as 7 to 40 hex characters, lower case; anything else is nothing.
func cleanHead(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) < 7 || len(s) > 40 {
		return ""
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return ""
		}
	}
	return s
}

// cleanExpect is the expected minutes: 0 (none) to a day.
func cleanExpect(n int) int {
	if n < 0 || n > maxExpect {
		return 0
	}
	return n
}

// Result answers POST /api/resources/{name}/result {subscriber_id, exit, line}: how the agent's own run went (#14857). An agent records only the result of its own hold, or of the one it has just given back.
func (h *ResourcesHandler) Result(w http.ResponseWriter, r *http.Request) {
	body, who, ok := h.agent(w, r)
	if !ok {
		return
	}
	if body.Exit == nil || *body.Exit < -1 || *body.Exit > 255 {
		errBadRequest(w, "exit must be a number from -1 to 255")
		return
	}
	h.reap()
	if err := h.M.Result(chi.URLParam(r, "name"), who, *body.Exit, cleanRunText(body.Line, maxRunLine)); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Release answers POST /api/resources/{name}/release.
func (h *ResourcesHandler) Release(w http.ResponseWriter, r *http.Request) {
	body, who, ok := h.agent(w, r)
	if !ok {
		return
	}
	h.reap()
	release := h.M.Queue().Release
	if body.KeepPlace {
		release = func(key, agent string) error { return h.M.Queue().Leave(key, agent, resourcequeue.DefaultAwayGrace) }
	}
	if err := release(chi.URLParam(r, "name"), who); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Renew answers POST /api/resources/{name}/renew.
func (h *ResourcesHandler) Renew(w http.ResponseWriter, r *http.Request) {
	_, who, ok := h.agent(w, r)
	if !ok {
		return
	}
	h.reap() // a lease that ran out is over: it cannot be renewed
	e, err := h.M.Queue().Renew(chi.URLParam(r, "name"), who)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entry": viewEntry(e, 0)})
}

// manager is who may define, remove and reorder: the Operator, or an agent whose own session is a registered Orchestrator by its launch record (can_peek), looked up by the verified session. Never by the name
// or job title an agent gave when it joined: that is caller-supplied (Security, #13613).
func (h *ResourcesHandler) manager(w http.ResponseWriter, r *http.Request) bool {
	actor := callerActor(r)
	if actor.IsOperator() {
		return true
	}
	if actor.Kind == ActorToken && actor.Session != "" && h.Board != nil {
		if is, err := h.Board.SessionIsRegisteredOrchestrator(r.Context(), actor.Session); err == nil && is {
			return true
		}
	}
	writeError(w, http.StatusForbidden, "manager_only", "only the Operator or an Orchestrator can define, remove or reorder resources")
	return false
}

// resourceNameRe is a resource's name: letters, digits, dot, dash and underscore. Nothing else is ever printed into an agent's terminal.
var resourceNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// cleanText drops control characters, trims and cuts to n runes: free text others will read.
func cleanText(s string, n int) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if rs := []rune(out); len(rs) > n {
		out = string(rs[:n])
	}
	return out
}

// Define answers PUT /api/resources/{name}.
func (h *ResourcesHandler) Define(w http.ResponseWriter, r *http.Request) {
	if !h.manager(w, r) {
		return
	}
	var body struct {
		Slots     int      `json:"slots"`
		Machine   string   `json:"machine"`
		MaxLeaseS int      `json:"max_lease_seconds"`
		Allowed   []string `json:"allowed"`
		Match     []string `json:"match"`
		Members   []string `json:"members"` // a pool (#13719)
	}
	if err := decodeJSONMax(w, r, &body, 8192); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	name := chi.URLParam(r, "name")
	if !resourceNameRe.MatchString(name) || (len(body.Members) == 0 && body.Slots < 1) || body.Slots > 100 || len(body.Members) > resourcequeue.MaxMembers || body.MaxLeaseS < 0 || body.MaxLeaseS > 24*3600 || len(body.Allowed) > 100 {
		errBadRequest(w, "name: letters, digits, dot, dash and underscore, up to 64; slots 1 to 100 (none for a pool, which lists up to 8 members); a lease up to a day; at most 100 allowed agents")
		return
	}
	allowed := make([]string, 0, len(body.Allowed))
	for _, a := range body.Allowed {
		if a = cleanText(a, 128); a != "" {
			allowed = append(allowed, a)
		}
	}
	if err := h.M.Queue().Define(resourcequeue.Resource{Key: name, Slots: body.Slots, Members: cleanMembers(body.Members), Machine: cleanText(body.Machine, 128), MaxLease: time.Duration(body.MaxLeaseS) * time.Second, Allowed: allowed, Match: body.Match}); err != nil {
		h.fail(w, err)
		return
	}
	st, _ := h.M.Queue().Status(name)
	writeJSON(w, http.StatusOK, viewStatus(st))
}

// Remove answers DELETE /api/resources/{name}.
func (h *ResourcesHandler) Remove(w http.ResponseWriter, r *http.Request) {
	if !h.manager(w, r) {
		return
	}
	if err := h.M.Queue().Remove(chi.URLParam(r, "name")); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func entryID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		errBadRequest(w, "entry id")
		return 0, false
	}
	return id, true
}

// Move answers POST /api/resources/entries/{id}/move.
func (h *ResourcesHandler) Move(w http.ResponseWriter, r *http.Request) {
	if !h.manager(w, r) {
		return
	}
	id, ok := entryID(w, r)
	if !ok {
		return
	}
	var body struct {
		How string `json:"how"`
	}
	if err := decodeJSONMax(w, r, &body, 1024); err != nil || (body.How != "first" && body.How != "up" && body.How != "down") {
		errBadRequest(w, `how is "first", "up" or "down"`)
		return
	}
	if err := h.M.Queue().Move(id, body.How); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Cancel answers DELETE /api/resources/entries/{id}.
func (h *ResourcesHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	if !h.manager(w, r) {
		return
	}
	id, ok := entryID(w, r)
	if !ok {
		return
	}
	if err := h.M.Queue().Cancel(id); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// cleanMembers are the member names of a pool; a name that cannot be a resource becomes one that cannot exist, so the queue refuses the pool.
func cleanMembers(in []string) []string {
	var out []string
	for _, m := range in {
		if resourceNameRe.MatchString(m) {
			out = append(out, m)
		} else {
			out = append(out, "?")
		}
	}
	return out
}

// addMachines gives each hold of a pool the machine of the member it got (#13719).
func (h *ResourcesHandler) addMachines(views []resourceView) {
	machine := map[string]string{}
	for _, st := range h.M.Queue().All() {
		machine[st.Resource.Key] = st.Resource.Machine
	}
	for i := range views {
		for j := range views[i].Holders {
			if e := &views[i].Holders[j]; e.Member != "" {
				e.Machine = machine[e.Member]
			}
		}
	}
}
