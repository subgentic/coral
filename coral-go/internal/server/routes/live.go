package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/live"
	"github.com/subgentic/coral/internal/secrets"
)

// Coral Live's local routes (#21047, design v4 14.4). Every one is the person's alone: never through Coral Hub (the table has no row, the golden says never, and a tunneled request is refused here too),
// never an agent's or a script's (refuseUnlessPerson), and every one answers 404 live_closed while the gate (live.Open, read once) is shut, before it reads or writes anything. No route returns a URL: the link lives on the Hub page.

// LiveHandler serves the routes. The manager is made on the first request after the gate opens, so a shut gate never touches the data folder.
type LiveHandler struct {
	h     *BoardHandler
	mu    sync.Mutex
	mgr   *live.Manager
	state func(subscriberID string) live.AgentState
	chat  func(a live.AgentRow) bool
	clock live.Clock
	// machineID is this computer's own id (tests set it). open is the gate, read once from live.Open.
	machineID func() (string, error)
	// hubLinks: this computer's own Hub links, with whether each is active now (the router gives the store's). Unset: none.
	hubLinks func(ctx context.Context) []HubLinkInfo
	open     bool
}

// NewLiveHandler makes the handler over the board's store and data folder.
func NewLiveHandler(h *BoardHandler) *LiveHandler {
	return &LiveHandler{h: h, machineID: dropbox.MachineID, open: live.Open}
}

// SetAgentState gives the handler the agents' working, waiting and sleeping state (the sessions the server keeps). Unset, every agent reads as idle.
func (lh *LiveHandler) SetAgentState(f func(subscriberID string) live.AgentState) { lh.state = f }

// HubLinkInfo is one of this computer's own Hub links: its id, the name the person gave it, and whether it is active now.
type HubLinkInfo struct {
	ID, Label string
	Active    bool
}

// SetHubLinks gives the handler this computer's Hub links.
func (lh *LiveHandler) SetHubLinks(f func(ctx context.Context) []HubLinkInfo) { lh.hubLinks = f }

func (lh *LiveHandler) activeLinks(ctx context.Context) []string {
	if lh.hubLinks == nil {
		return nil
	}
	var ids []string
	for _, l := range lh.hubLinks(ctx) {
		if l.Active {
			ids = append(ids, l.ID)
		}
	}
	return ids
}

// liveVia is the Hub link a live link pushes through, as the page shows it: the id, the name the person gave it (never a URL) and whether it is active now.
type liveVia struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

func (lh *LiveHandler) viaOf(ctx context.Context, id string) liveVia {
	v := liveVia{ID: id}
	if lh.hubLinks == nil || id == "" {
		return v
	}
	for _, l := range lh.hubLinks(ctx) {
		if l.ID == id {
			v.Active = l.Active
			if !strings.Contains(l.Label, "://") {
				v.Name = l.Label
			}
		}
	}
	return v
}

func (lh *LiveHandler) linkActive(id string) bool {
	if id == "" {
		return false
	}
	for _, a := range lh.activeLinks(context.Background()) {
		if a == id {
			return true
		}
	}
	return false
}

// Run is the pusher's ticker: about every `every` (a second in production) until ctx ends it applies the clock and pushes. With the gate shut it returns at once and reads and writes nothing.
func (lh *LiveHandler) Run(ctx context.Context, send live.Transport, every time.Duration) {
	if !lh.open {
		return
	}
	m, err := lh.manager()
	if err != nil {
		return // no machine id: fail closed, nothing is pushed
	}
	p := live.NewPusher(m, send)
	defer p.Wipe()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.Step(ctx)
		}
	}
}

func (lh *LiveHandler) manager() (*live.Manager, error) {
	lh.mu.Lock()
	defer lh.mu.Unlock()
	if lh.mgr != nil {
		return lh.mgr, nil
	}
	var st live.Store = &live.MemStore{}
	if lh.h.coralDir != "" {
		st = live.FileStore{Path: filepath.Join(lh.h.coralDir, "live_links.json")}
	}
	// The link is bound to this computer: a hash of its machine id (never shown or logged). A copied data folder or another computer brings it back paused.
	id, err := lh.machineID()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte("coral-live-computer:" + id))
	computer := hex.EncodeToString(sum[:])
	state := lh.state
	m, err := live.NewManager(live.Config{
		Clock: lh.clock, Store: st, Computer: computer, LinkActive: lh.linkActive,
		Source: func(team string) live.LiveSource { return live.NewBoardSource(lh.h.bs, team, state) },
		// Chat is the chat slice's: until it lands no agent has it.
		ChatAvailable: lh.chat,
		Redactor:      secrets.HubRedactor(func() bool { return true }),
	})
	if err != nil {
		return nil, err
	}
	lh.mgr = m
	return m, nil
}

func liveErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// guard is the common front of every route: gate, then not through the Hub, then a person. It reports true when the request may go on.
func (lh *LiveHandler) guard(w http.ResponseWriter, r *http.Request) (*live.Manager, bool) {
	if !lh.open {
		liveErr(w, http.StatusNotFound, "live_closed")
		return nil, false
	}
	if cloud.Tunneled(r) {
		liveErr(w, http.StatusForbidden, "operator_only")
		return nil, false
	}
	if !humanInputCaller(r) {
		liveErr(w, http.StatusForbidden, "operator_only")
		return nil, false
	}
	m, err := lh.manager()
	if err != nil {
		liveErr(w, http.StatusInternalServerError, "internal")
		return nil, false
	}
	return m, true
}

func liveFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, live.ErrNotFound):
		liveErr(w, http.StatusNotFound, "not_found")
	case errors.Is(err, live.ErrBadHash):
		liveErr(w, http.StatusConflict, "bad_hash")
	case errors.Is(err, live.ErrState):
		liveErr(w, http.StatusConflict, "bad_state")
	case errors.Is(err, live.ErrChatUnavailable):
		liveErr(w, http.StatusBadRequest, "chat_unavailable")
	case errors.Is(err, live.ErrBadPeriod):
		liveErr(w, http.StatusBadRequest, "bad_period")
	case errors.Is(err, live.ErrBadHubLink):
		liveErr(w, http.StatusBadRequest, "bad_hub_link")
	case errors.Is(err, live.ErrBadVia):
		liveErr(w, http.StatusBadRequest, "bad_via")
	case errors.Is(err, live.ErrNotRead):
		liveErr(w, http.StatusBadRequest, "not_read")
	case errors.Is(err, live.ErrBadViews):
		liveErr(w, http.StatusBadRequest, "bad_views")
	default:
		liveErr(w, http.StatusInternalServerError, "internal")
	}
}

type liveAgentView struct {
	Key       string `json:"key"`
	Role      string `json:"role"`
	Status    string `json:"status"`
	Chat      bool   `json:"chat"`       // chat in the view that is LIVE (the approved one) when the link is live, else in the draft
	InView    bool   `json:"in_view"`    // shown to the public: in the approved snapshot of a live link (an agent that joined later is not), every agent of a draft
	DraftChat bool   `json:"draft_chat"` // the draft's chat pick, which is what the next go-live or resume would show
}

// liveDraftView is the draft the controls edit; on a live link it can differ from the approved fields next to it.
type liveDraftView struct {
	ChatKey    string `json:"chat_key"`
	PeriodDays int    `json:"period_days"`
	ExpiresIn  string `json:"expires_in"`
	DelayS     int    `json:"delay_s"`
}

type liveLinkView struct {
	ID           string          `json:"id"`
	Team         string          `json:"team"`
	Hub          string          `json:"hub"`
	State        live.State      `json:"state"`
	PausedReason string          `json:"paused_reason"`
	Agents       []liveAgentView `json:"agents"`
	CreatedBy    string          `json:"created_by"`
	LiveSince    *time.Time      `json:"live_since,omitempty"`
	ExpiresIn    string          `json:"expires_in"`
	DelayS       int             `json:"delay_s"`
	PeriodDays   int             `json:"period_days"`
	ConfirmedAt  *time.Time      `json:"confirmed_at,omitempty"`
	ReconfirmDue *time.Time      `json:"reconfirm_due,omitempty"`
	PauseAt      *time.Time      `json:"pause_at,omitempty"`
	NoticeAt     *time.Time      `json:"notice_at,omitempty"`
	LastViewedS  *int64          `json:"last_viewed_age_s,omitempty"`
	HubStops     int             `json:"hub_stop_count"`
	ChatOffWhy   string          `json:"chat_off_why,omitempty"`
	Draft        liveDraftView   `json:"draft"`
	Via          liveVia         `json:"via"`
}

func tp(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func (lh *LiveHandler) view(ctx context.Context, m *live.Manager, l live.Link) liveLinkView {
	v := liveLinkView{ID: l.ID, Team: l.Team, Hub: l.HubLink, State: l.State, PausedReason: l.PausedReason, CreatedBy: l.CreatedBy,
		ExpiresIn: l.Views.ExpiresIn, DelayS: l.Views.DelayS, PeriodDays: l.Views.PeriodDays, LastViewedS: l.LastViewedS, HubStops: l.HubStops, ChatOffWhy: l.ChatOffWhy, Agents: []liveAgentView{},
		Draft: liveDraftView{ChatKey: l.Views.ChatKey, PeriodDays: l.Views.PeriodDays, ExpiresIn: l.Views.ExpiresIn, DelayS: l.Views.DelayS}}
	v.Via = lh.viaOf(ctx, l.Via)
	approvedKeys := map[string]bool{}
	isLive := l.Approved != nil && l.State == live.StateLive
	chatKey := l.Views.ChatKey
	if isLive {
		for _, k := range l.Approved.AgentKeys {
			approvedKeys[k] = true
		}
		chatKey = l.Approved.ChatKey
		v.ExpiresIn, v.DelayS, v.PeriodDays = l.Approved.ExpiresIn, l.Approved.DelayS, l.Approved.PeriodDays
	}
	if rows, err := live.NewBoardSource(lh.h.bs, l.Team, lh.state).Agents(ctx); err == nil {
		for _, r := range rows {
			if r.Key == "" || r.Archived {
				continue
			}
			v.Agents = append(v.Agents, liveAgentView{Key: r.Key, Role: r.Role, Status: string(live.StatusFrom(r)), Chat: r.Key == chatKey && chatKey != "", InView: !isLive || approvedKeys[r.Key], DraftChat: r.Key == l.Views.ChatKey && l.Views.ChatKey != ""})
		}
	}
	if l.State == live.StateLive || l.State == live.StatePaused {
		v.LiveSince, v.ConfirmedAt = tp(l.LiveSince), tp(l.ConfirmedAt)
		due, pause := live.Deadlines(l)
		v.ReconfirmDue, v.PauseAt, v.NoticeAt = tp(due), tp(pause), tp(live.NoticeAt(l))
	}
	return v
}

// ListLinks: GET /api/live/links -> {"links":[...]}. It also applies the clock, so a link past its grace shows paused.
func (lh *LiveHandler) ListLinks(w http.ResponseWriter, r *http.Request) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	_ = m.Tick(r.Context())
	out := []liveLinkView{}
	for _, l := range m.List() {
		out = append(out, lh.view(r.Context(), m, l))
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": out})
}

// CreateLink: POST /api/live/links {hub_link, team}. The draft shows every agent, chat off.
func (lh *LiveHandler) CreateLink(w http.ResponseWriter, r *http.Request) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	var body struct {
		HubLink string `json:"hub_link"`
		Team    string `json:"team"`
		Via     string `json:"via"` // which of this computer's own Hub links to push through; omitted when there is exactly one active
	}
	if err := decodeJSONStrict(r, &body); err != nil {
		liveErr(w, http.StatusBadRequest, "bad_views")
		return
	}
	if subs, err := lh.h.bs.ListAllSubscribers(r.Context(), body.Team); err != nil || len(subs) == 0 {
		liveErr(w, http.StatusBadRequest, "bad_views")
		return
	}
	via := body.Via
	if via == "" {
		if ids := lh.activeLinks(r.Context()); len(ids) == 1 {
			via = ids[0]
		}
	}
	l, err := m.Create(body.HubLink, body.Team, "Operator", via)
	if err != nil {
		liveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lh.view(r.Context(), m, l))
}

// SetViews: PUT /api/live/links/{id}/views {chat_key, period_days, expires_in, delay_s}. There is no per-agent hide.
func (lh *LiveHandler) SetViews(w http.ResponseWriter, r *http.Request) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	var v live.Views
	if err := decodeJSONStrict(r, &v); err != nil {
		liveErr(w, http.StatusBadRequest, "bad_views")
		return
	}
	l, err := m.SetViews(r.Context(), chi.URLParam(r, "id"), v)
	if err != nil {
		liveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lh.view(r.Context(), m, l))
}

// Preview: GET /api/live/links/{id}/preview -> {hash, frame}: exactly what a viewer would see, with the withheld markers.
func (lh *LiveHandler) Preview(w http.ResponseWriter, r *http.Request) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	p, err := m.Preview(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		liveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type liveHashBody struct {
	Hash string `json:"hash"`
	Read bool   `json:"read"`
}

// GoLive: POST /api/live/links/{id}/go-live {hash, read:true}. The hash must be the one of the preview just read.
func (lh *LiveHandler) GoLive(w http.ResponseWriter, r *http.Request) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	var b liveHashBody
	if err := decodeJSONStrict(r, &b); err != nil {
		liveErr(w, http.StatusBadRequest, "bad_views")
		return
	}
	l, err := m.GoLive(r.Context(), chi.URLParam(r, "id"), b.Hash, b.Read)
	if err != nil {
		liveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lh.view(r.Context(), m, l))
}

// Resume: POST /api/live/links/{id}/resume {hash}: a person's confirm after a pause.
func (lh *LiveHandler) Resume(w http.ResponseWriter, r *http.Request) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	var b liveHashBody
	if err := decodeJSONStrict(r, &b); err != nil {
		liveErr(w, http.StatusBadRequest, "bad_views")
		return
	}
	l, err := m.Resume(r.Context(), chi.URLParam(r, "id"), b.Hash)
	if err != nil {
		liveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lh.view(r.Context(), m, l))
}

func (lh *LiveHandler) simple(w http.ResponseWriter, r *http.Request, do func(m *live.Manager, id string) (live.Link, error)) {
	m, ok := lh.guard(w, r)
	if !ok {
		return
	}
	var empty struct{}
	if err := decodeJSONStrict(r, &empty); err != nil && !errors.Is(err, io.EOF) {
		liveErr(w, http.StatusBadRequest, "bad_views")
		return
	}
	l, err := do(m, chi.URLParam(r, "id"))
	if err != nil {
		liveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lh.view(r.Context(), m, l))
}

// Reconfirm: POST /api/live/links/{id}/reconfirm {}.
func (lh *LiveHandler) Reconfirm(w http.ResponseWriter, r *http.Request) {
	lh.simple(w, r, func(m *live.Manager, id string) (live.Link, error) { return m.Reconfirm(id) })
}

// Pause: POST /api/live/links/{id}/pause {}.
func (lh *LiveHandler) Pause(w http.ResponseWriter, r *http.Request) {
	lh.simple(w, r, func(m *live.Manager, id string) (live.Link, error) { return m.Pause(id) })
}

// Stop: POST /api/live/links/{id}/stop {}: local, at once, and it wins.
func (lh *LiveHandler) Stop(w http.ResponseWriter, r *http.Request) {
	lh.simple(w, r, func(m *live.Manager, id string) (live.Link, error) { return m.Stop(id) })
}
