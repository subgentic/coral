package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// The self-hosted Hub's Needs you across its computers (#15380, B). GET /api/needs-you on a Hub also reads each registered computer's own /api/needs-you through the hub proxy and merges the answers,
// under Security's conditions: the read goes out only for the signed-in owner's real sign-in session (never an API key, a push poller or a background job, which get the Hub's own answer as before), only on
// the first page of a read (no ?after=), and the Hub rebuilds every item from what it decodes: unknown fields and kinds are dropped, counts are non-negative integers, text is cleaned and cut again, the
// id is "<the Hub's own id for the computer>/<the computer's id>", and no link is passed through (the page builds its links from ids). One computer that fails, is slow, answers too much or does not know the
// route is left out and named; it never fails the read.
const (
	hubNeedsItemsPerMachine = needsYouItemsMax // at most this many items are taken from one computer (its counts are still summed whole)
	hubNeedsMachines        = 32               // at most this many computers are read
	hubNeedsBodyMax         = 256 << 10        // a computer's answer over this is refused
	hubNeedsMachineTimeout  = 4 * time.Second
	hubNeedsTotalDeadline   = 6 * time.Second
	hubNeedsParallel        = 4
	hubNeedsCacheTTL        = 3 * time.Second
	hubNeedsCountMax        = 1_000_000
	hubNeedsIDMax           = 200
)

// NeedsYouMachine is one computer the merged answer covers: the Hub's own id for it, its label (cleaned) and "ok", "offline" or "failed".
type NeedsYouMachine struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"`
}

// NeedsYouRemotes is what the Hub gives the board to read its computers: their list and the hub proxy handler (so every call goes through its allowlist, signing and address guards).
type NeedsYouRemotes struct {
	List  func(ctx context.Context) ([]store.RemoteServer, error)
	Proxy http.Handler
	mu    sync.Mutex
	cache map[string]hubNeedsCached
}

type hubNeedsCached struct {
	at  time.Time
	out hubNeedsMerged
}

// hubNeedsMerged is what the computers added: items (already rebuilt), the sums of their counts, the machines and the ones that could not be read.
type hubNeedsMerged struct {
	Items    []NeedsYouItem
	Counts   map[string]int
	Machines []NeedsYouMachine
	Failed   bool
}

// SetNeedsYouRemotes gives a Hub's board its computers (hub mode only; nil: this Coral's own answer alone).
func (h *BoardHandler) SetNeedsYouRemotes(r *NeedsYouRemotes) { h.needsYouRemotes = r }

// proxyContext is the request's context as the hub's proxy reads it: the person signed in at this Hub (a dashboard session or this computer's own browser) may have a call signed, and only a real sign-in
// session the widened routes (#13694, #13725). One place, so the proxy mount and this merge cannot differ.
func proxyContext(req *http.Request) *http.Request {
	if humanInputCaller(req) {
		req = req.WithContext(proxy.WithSignedInOwner(req.Context()))
		if kind, _ := req.Context().Value(callerKindKey{}).(string); kind == callerDashCookie {
			req = req.WithContext(proxy.WithSessionSignedIn(req.Context()))
		}
	}
	return req
}

// realSession: the caller holds a real sign-in session at this Hub, the only caller a merged read is made for.
func realSession(r *http.Request) bool {
	if !humanInputCaller(r) {
		return false
	}
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	return kind == callerDashCookie
}

// capWriter keeps a computer's answer in memory up to a cap and refuses more.
type capWriter struct {
	h    http.Header
	code int
	buf  []byte
	over bool
	max  int
}

func (w *capWriter) Header() http.Header { return w.h }
func (w *capWriter) WriteHeader(c int) {
	if w.code == 0 {
		w.code = c
	}
}
func (w *capWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	if len(w.buf)+len(p) > w.max {
		w.over = true
		return 0, http.ErrBodyNotAllowed
	}
	w.buf = append(w.buf, p...)
	return len(p), nil
}

// remoteNeedsIn is what is read of a computer's answer; anything else it sends is not decoded.
type remoteNeedsIn struct {
	Counts map[string]json.Number `json:"counts"`
	Items  []struct {
		Kind         string      `json:"kind"`
		From         string      `json:"from"`
		Line         string      `json:"line"`
		Team         string      `json:"team"`
		ID           string      `json:"id"`
		At           string      `json:"at"`
		GoalID       json.Number `json:"goal_id"`
		TaskID       json.Number `json:"task_id"`
		GoalTitle    string      `json:"goal_title"`
		TaskTitle    string      `json:"task_title"`
		NewComments  json.Number `json:"new_comments"`
		StillWaiting bool        `json:"still_waiting"`
	} `json:"items"`
}

func nonNegInt(n json.Number, max int64) int64 {
	v, err := strconv.ParseInt(string(n), 10, 64)
	if err != nil || v < 0 {
		return 0
	}
	return min(v, max)
}

// needsYouTitle is a goal or task title as one cleaned, cut line.
func needsYouTitle(s string) string {
	red, ok := redactComment(s) // secrets out BEFORE the cut, as needsYouLine does; with no redactor nothing is sent (#15404)
	if !ok {
		return needsYouWithheld
	}
	s = strings.Join(strings.Fields(clitext.CleanName(red)), " ")
	if r := []rune(s); len(r) > needsYouLineMax {
		return strings.TrimSpace(string(r[:needsYouLineMax-1])) + "…"
	}
	return s
}

// rebuildRemoteNeeds turns one computer's answer into items of the merged one. machine is the Hub's own id for the computer. ok is false when the answer does not read.
func rebuildRemoteNeeds(machine string, body []byte) (items []NeedsYouItem, counts map[string]int, ok bool) {
	var in remoteNeedsIn
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, nil, false
	}
	counts = map[string]int{}
	for k, v := range in.Counts {
		if needsYouKinds[k] {
			counts[k] = int(nonNegInt(v, hubNeedsCountMax))
		}
	}
	for _, it := range in.Items {
		if len(items) == hubNeedsItemsPerMachine {
			break
		}
		if !needsYouKinds[it.Kind] || it.ID == "" || len(it.ID) > hubNeedsIDMax {
			continue
		}
		id := clitext.CleanName(it.ID)
		if id == "" {
			continue
		}
		items = append(items, NeedsYouItem{
			Kind: it.Kind, From: needsYouTitle(it.From), Line: needsYouLine(it.Line), Team: needsYouTitle(it.Team),
			ID: machine + "/" + id, At: needsYouTime(it.At), Server: machine,
			GoalID: int64(nonNegInt(it.GoalID, 1<<53)), TaskID: int64(nonNegInt(it.TaskID, 1<<53)),
			GoalTitle: needsYouTitle(it.GoalTitle), TaskTitle: needsYouTitle(it.TaskTitle),
			NewComments: int(nonNegInt(it.NewComments, hubNeedsCountMax)), StillWaiting: it.StillWaiting,
		})
	}
	return items, counts, true
}

// readMachine asks one computer for its Needs you through the hub proxy, as the signed-in owner.
func (nr *NeedsYouRemotes) readMachine(r *http.Request, id, kind string) ([]NeedsYouItem, map[string]int, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), hubNeedsMachineTimeout)
	defer cancel()
	q := url.Values{"limit": {strconv.Itoa(hubNeedsItemsPerMachine)}}
	if kind != "" {
		q.Set("kind", kind)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "/api/remote/"+url.PathEscape(id)+"/api/needs-you?"+q.Encode(), http.NoBody)
	if err != nil {
		return nil, nil, false
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("server", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	req = proxyContext(r.WithContext(req.Context()))
	req.Method, req.URL = http.MethodGet, &url.URL{Path: "/api/remote/" + id + "/api/needs-you", RawQuery: q.Encode()}
	w := &capWriter{h: http.Header{}, max: hubNeedsBodyMax}
	nr.Proxy.ServeHTTP(w, req)
	if w.over || w.code != http.StatusOK {
		return nil, nil, false
	}
	return rebuildRemoteNeeds(id, w.buf)
}

// merge reads every computer (a few at a time, under one deadline) and returns what they add. A computer that is not online is named, not asked.
func (nr *NeedsYouRemotes) merge(r *http.Request, kind string) hubNeedsMerged {
	out := hubNeedsMerged{Counts: map[string]int{}}
	list, err := nr.List(r.Context())
	if err != nil {
		out.Failed = true
		return out
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	if len(list) > hubNeedsMachines {
		list = list[:hubNeedsMachines]
		out.Failed = true
	}
	ctx, cancel := context.WithTimeout(r.Context(), hubNeedsTotalDeadline)
	defer cancel()
	r = r.WithContext(ctx)
	type res struct {
		items  []NeedsYouItem
		counts map[string]int
		ok     bool
	}
	results := make([]res, len(list))
	sem := make(chan struct{}, hubNeedsParallel)
	var wg sync.WaitGroup
	for i, m := range list {
		if m.Status != "online" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer safego.Recover("needs-you-hub: read a machine")
			defer wg.Done()
			defer func() { <-sem }()
			it, c, ok := nr.readMachine(r, m.ID, kind)
			results[i] = res{it, c, ok}
		}()
	}
	wg.Wait()
	for i, m := range list {
		st := "ok"
		switch {
		case m.Status != "online":
			st, out.Failed = "offline", true
		case !results[i].ok:
			st, out.Failed = "failed", true
		default:
			out.Items = append(out.Items, results[i].items...)
			for k, v := range results[i].counts {
				out.Counts[k] += v
			}
		}
		out.Machines = append(out.Machines, NeedsYouMachine{ID: m.ID, Label: needsYouTitle(m.Label), Status: st})
	}
	return out
}

// mergedNeeds is merge with a few seconds of memory, kept for the one owner of this Hub (a read is for the owner alone, so the key is the read's shape).
func (nr *NeedsYouRemotes) mergedNeeds(r *http.Request, kind string) hubNeedsMerged {
	key := kind
	nr.mu.Lock()
	if c, ok := nr.cache[key]; ok && time.Since(c.at) < hubNeedsCacheTTL {
		nr.mu.Unlock()
		return c.out
	}
	nr.mu.Unlock()
	out := nr.merge(r, kind)
	if r.Context().Err() != nil {
		return out // the first caller went away: the computers it did not get to were cut, not down, so its answer is not kept for the next reader (#15404)
	}
	nr.mu.Lock()
	if nr.cache == nil {
		nr.cache = map[string]hubNeedsCached{}
	}
	nr.cache[key] = hubNeedsCached{time.Now(), out}
	nr.mu.Unlock()
	return out
}

// Forget drops what was kept (the owner signed out, or a computer was removed).
func (nr *NeedsYouRemotes) Forget() {
	nr.mu.Lock()
	nr.cache = nil
	nr.mu.Unlock()
}
