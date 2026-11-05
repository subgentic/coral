package routes

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

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
}

type entryView struct {
	ID       int64  `json:"id"`
	Agent    string `json:"agent"`
	Task     int    `json:"task,omitempty"`
	Priority int    `json:"priority"`
	Note     string `json:"note,omitempty"`
	Enqueued string `json:"enqueued_at"`
	Granted  string `json:"granted_at,omitempty"`
	Lease    string `json:"lease_until,omitempty"`
	Pinned   bool   `json:"pinned,omitempty"`
	Place    int    `json:"place,omitempty"`
}

type resourceView struct {
	Name     string      `json:"name"`
	Slots    int         `json:"slots"`
	Machine  string      `json:"machine,omitempty"`
	MaxLease int         `json:"max_lease_seconds"`
	Allowed  []string    `json:"allowed,omitempty"`
	Holders  []entryView `json:"holders"`
	Queue    []entryView `json:"queue"`
}

func viewEntry(e resourcequeue.Entry, place int) entryView {
	v := entryView{ID: e.ID, Agent: e.Agent, Task: e.Task, Priority: e.Priority, Note: e.Note, Enqueued: e.Enqueued.UTC().Format(time.RFC3339), Pinned: e.Pin > 0, Place: place}
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
	v := resourceView{Name: st.Resource.Key, Slots: st.Resource.Slots, Machine: st.Resource.Machine, MaxLease: int(lease / time.Second), Allowed: st.Resource.Allowed, Holders: []entryView{}, Queue: []entryView{}}
	for _, e := range st.Holders {
		v.Holders = append(v.Holders, viewEntry(e, 0))
	}
	for i, e := range st.Queue {
		v.Queue = append(v.Queue, viewEntry(e, i+1))
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
	case errors.Is(err, resourcequeue.ErrBadResource):
		errBadRequest(w, err.Error())
	default:
		errInternalServer(w, err.Error())
	}
}

// reap keeps the line honest on every call: leases that ran out end and agents that are gone are dropped before the answer is made.
func (h *ResourcesHandler) reap() { _, _ = h.M.Queue().Reap() }

// List answers GET /api/resources.
func (h *ResourcesHandler) List(w http.ResponseWriter, r *http.Request) {
	h.reap()
	out := []resourceView{}
	for _, st := range h.M.Queue().All() {
		out = append(out, viewStatus(st))
	}
	writeJSON(w, http.StatusOK, map[string]any{"resources": out})
}

// Get answers GET /api/resources/{name}.
func (h *ResourcesHandler) Get(w http.ResponseWriter, r *http.Request) {
	h.reap()
	st, err := h.M.Queue().Status(urlParam(r, "name"))
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewStatus(st))
}

type agentBody struct {
	SubscriberID string `json:"subscriber_id"`
	Note         string `json:"note"`
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
	name := urlParam(r, "name")
	res, err := h.M.Claim(r.Context(), name, who, strings.TrimSpace(body.Note))
	if err != nil {
		h.fail(w, err)
		return
	}
	code := http.StatusOK
	if !res.Granted {
		code = http.StatusAccepted
	}
	writeJSON(w, code, map[string]any{"granted": res.Granted, "place": res.Place, "entry": viewEntry(res.Entry, res.Place)})
}

// Release answers POST /api/resources/{name}/release.
func (h *ResourcesHandler) Release(w http.ResponseWriter, r *http.Request) {
	_, who, ok := h.agent(w, r)
	if !ok {
		return
	}
	if err := h.M.Queue().Release(urlParam(r, "name"), who); err != nil {
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
	e, err := h.M.Queue().Renew(urlParam(r, "name"), who)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entry": viewEntry(e, 0)})
}

// manager is who may define, remove and reorder: the Operator, or an Orchestrator on any board.
func (h *ResourcesHandler) manager(w http.ResponseWriter, r *http.Request) bool {
	actor := callerActor(r)
	if actor.IsOperator() {
		return true
	}
	if name, verified := actorName(actor); verified && h.Board != nil {
		if is, err := h.Board.IsOrchestratorAnywhere(r.Context(), name); err == nil && is {
			return true
		}
	}
	writeError(w, http.StatusForbidden, "manager_only", "only the Operator or an Orchestrator can define, remove or reorder resources")
	return false
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
	}
	if err := decodeJSONMax(w, r, &body, 8192); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	name := strings.TrimSpace(urlParam(r, "name"))
	if len(name) > 64 || strings.ContainsAny(name, " \t/\\") || body.MaxLeaseS < 0 || body.MaxLeaseS > 24*3600 || len(body.Allowed) > 100 || len(body.Machine) > 128 || body.Slots > 100 {
		errBadRequest(w, "name up to 64 characters with no spaces or slashes, slots 1 to 100, a lease up to a day")
		return
	}
	if err := h.M.Queue().Define(resourcequeue.Resource{Key: name, Slots: body.Slots, Machine: strings.TrimSpace(body.Machine), MaxLease: time.Duration(body.MaxLeaseS) * time.Second, Allowed: body.Allowed}); err != nil {
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
	if err := h.M.Queue().Remove(urlParam(r, "name")); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func entryID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(urlParam(r, "id"), 10, 64)
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
