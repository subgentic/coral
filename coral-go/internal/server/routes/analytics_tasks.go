package routes

import (
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/efficiency"
	"github.com/subgentic/coral/internal/store"
)

// GET /api/analytics/tasks?range=24h|7d|14d|30d|90d&group_by=agent|team|model|provider[&reviews=1] (#17206, the Operator's "how many tasks is each agent completing"): the tasks completed in a window,
// from every board on this computer, counted like the usage breakdowns: one series per group over daily buckets (hourly for 24h), and a table row per group (completed, failed, median time claimed to done,
// tokens and cost per task). A task is "completed" when its status is completed (a cancelled one is not), so with reviews=1 the total is the count `coral-board task list` shows for the same window; the
// default leaves out the reviewers' own tasks ("Review #N"), which are not work on the product. "Failed" is the part of Completed whose outcome is failed. Who did the work, and the time, are the
// efficiency read's rules (board.EfficiencyTasksAll); the model is the one that spent most of the session's tokens in the window, else its live row's. Counts and names only, never a task's text. NEVER
// through Coral Hub (like the efficiency read): it names agents.

// TasksAnalyticsHandler serves the read.
type TasksAnalyticsHandler struct {
	ts  *store.TokenUsageStore
	ss  *store.SessionStore
	bs  *board.Store
	now func() time.Time
}

// NewTasksAnalyticsHandler creates the handler.
func NewTasksAnalyticsHandler(db *store.DB, bs *board.Store) *TasksAnalyticsHandler {
	return &TasksAnalyticsHandler{ts: store.NewTokenUsageStore(db), ss: store.NewSessionStore(db), bs: bs}
}

func (h *TasksAnalyticsHandler) clock() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

var tasksRanges = map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "14d": 14 * 24 * time.Hour, "30d": 30 * 24 * time.Hour, "90d": 90 * 24 * time.Hour}

const tasksNotRecorded = "Not recorded"

type tasksGroup struct {
	Key           string   `json:"key"`
	Label         string   `json:"label"`
	Completed     int      `json:"completed"`
	Failed        int      `json:"failed"`
	MedianSeconds *float64 `json:"median_seconds,omitempty"` // claimed to done, review not counted; absent when no task of the group has a time
	TokensPerTask *float64 `json:"tokens_per_task,omitempty"`
	CostPerTask   *float64 `json:"cost_per_task,omitempty"` // absent when the group's tasks recorded no cost
	Series        []int    `json:"series"`
}

type tasksAnswer struct {
	Range          string   `json:"range"`
	GroupBy        string   `json:"group_by"`
	IncludeReviews bool     `json:"include_reviews"`
	GeneratedAt    string   `json:"generated_at"`
	Bucket         string   `json:"bucket"`  // day or hour
	Buckets        []string `json:"buckets"` // each bucket's start, RFC 3339 UTC
	Total          struct {
		Completed int `json:"completed"`
		Failed    int `json:"failed"`
	} `json:"total"`
	Groups []tasksGroup `json:"groups"`
}

// Tasks answers the read.
func (h *TasksAnalyticsHandler) Tasks(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (coral-hub #261001): the names of the team's own agents, teams, models and branches
		return
	}
	q := r.URL.Query()
	rng, dim := q.Get("range"), q.Get("group_by")
	if rng == "" {
		rng = "14d"
	}
	if dim == "" {
		dim = "agent"
	}
	dur, ok := tasksRanges[rng]
	if !ok {
		errBadRequest(w, "range must be 24h, 7d, 14d, 30d or 90d")
		return
	}
	if dim != "agent" && dim != "team" && dim != "model" && dim != "provider" {
		errBadRequest(w, "group_by must be agent, team, model or provider")
		return
	}
	reviews := q.Get("reviews") == "1"
	now := h.clock()
	step := 24 * time.Hour
	bucket := "day"
	var first time.Time
	if rng == "24h" {
		step, bucket = time.Hour, "hour"
		first = now.Truncate(time.Hour).Add(-23 * time.Hour)
	} else {
		first = now.Truncate(24 * time.Hour).Add(-dur + 24*time.Hour)
	}
	since := first
	ctx := r.Context()
	fail := func(err error) {
		slog.Error("tasks analytics read failed", "error", err)
		errInternalServer(w, "the tasks read failed")
	}
	tasks, err := h.bs.EfficiencyTasksAll(ctx, since.Format(time.RFC3339), now.Add(time.Second).Format(time.RFC3339), reviews)
	if err != nil {
		fail(err)
		return
	}
	live, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		fail(err)
		return
	}
	liveBy := make(map[string]store.LiveSession, len(live))
	for _, ls := range live {
		liveBy[ls.SessionID] = ls
	}
	var sessions []string
	seen := map[string]bool{}
	for _, t := range tasks {
		if t.Session != "" && !seen[t.Session] {
			seen[t.Session] = true
			sessions = append(sessions, t.Session)
		}
	}
	facts, err := h.ss.SessionFacts(ctx, sessions)
	if err != nil {
		fail(err)
		return
	}
	usage, err := h.ts.EfficiencyUsage(ctx, since.Format(time.RFC3339), now.Add(time.Second).Format(time.RFC3339), true)
	if err != nil {
		fail(err)
		return
	}
	rows := make([]efficiency.UsageRow, 0, len(usage))
	for _, u := range usage {
		rows = append(rows, efficiency.UsageRow{Session: u.SessionID, Provider: u.AgentType, Team: u.Team, Model: u.Model, Tokens: u.Tokens, CostUSD: u.CostUSD})
	}
	dominant := efficiency.DominantModels(rows)
	boards := map[string]bool{}
	for _, t := range tasks {
		boards[t.Board] = true
	}
	ids := make([]string, 0, len(boards))
	for id := range boards {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	labels := h.bs.BoardLabels(ctx, ids)

	n := 0
	for t := first; !t.After(now); t = t.Add(step) {
		n++
	}
	ans := tasksAnswer{Range: rng, GroupBy: dim, IncludeReviews: reviews, GeneratedAt: now.Format(time.RFC3339), Bucket: bucket, Buckets: make([]string, n), Groups: []tasksGroup{}}
	for i := range ans.Buckets {
		ans.Buckets[i] = first.Add(time.Duration(i) * step).Format(time.RFC3339)
	}
	type acc struct {
		g       tasksGroup
		secs    []float64
		tokens  int64
		cost    float64
		hasCost bool
	}
	groups := map[string]*acc{}
	for _, t := range tasks {
		done, err := time.Parse(time.RFC3339, t.CompletedAt)
		if err != nil || done.Before(first) || done.After(now.Add(time.Second)) {
			continue
		}
		idx := int(done.UTC().Sub(first) / step)
		if idx < 0 {
			continue
		}
		if idx >= n {
			idx = n - 1
		}
		key, label := tasksNotRecorded, tasksNotRecorded
		ls := liveBy[t.Session]
		switch dim {
		case "agent":
			if strings.TrimSpace(t.Claimer) != "" {
				key, label = t.Claimer, t.Claimer
			}
		case "team":
			if strings.TrimSpace(t.Board) != "" {
				key = t.Board
				label = labels[t.Board]
				if label == "" {
					label = t.Board
				}
			}
		case "model":
			m := dominant[t.Session]
			if m == "" {
				m = deref(ls.Model)
			}
			if strings.TrimSpace(m) != "" {
				key, label = m, m
			}
		case "provider":
			p := ls.AgentType
			if p == "" {
				p = facts[t.Session].Provider
			}
			if strings.TrimSpace(p) != "" {
				key, label = p, p
			}
		}
		a := groups[key]
		if a == nil {
			a = &acc{g: tasksGroup{Key: key, Label: label, Series: make([]int, n)}}
			groups[key] = a
		}
		a.g.Completed++
		a.g.Series[idx]++
		ans.Total.Completed++
		if t.Failed {
			a.g.Failed++
			ans.Total.Failed++
		}
		if t.WorkSeconds != nil {
			a.secs = append(a.secs, *t.WorkSeconds)
		}
		a.tokens += t.Tokens
		if t.CostUSD > 0 {
			a.cost += t.CostUSD
			a.hasCost = true
		}
	}
	for _, a := range groups {
		if len(a.secs) > 0 {
			sort.Float64s(a.secs)
			m := a.secs[len(a.secs)/2]
			if len(a.secs)%2 == 0 {
				m = (a.secs[len(a.secs)/2-1] + a.secs[len(a.secs)/2]) / 2
			}
			a.g.MedianSeconds = &m
		}
		if a.tokens > 0 {
			v := float64(a.tokens) / float64(a.g.Completed)
			a.g.TokensPerTask = &v
		}
		if a.hasCost {
			v := a.cost / float64(a.g.Completed)
			a.g.CostPerTask = &v
		}
		ans.Groups = append(ans.Groups, a.g)
	}
	sort.Slice(ans.Groups, func(i, j int) bool {
		a, b := ans.Groups[i], ans.Groups[j]
		if (a.Key == tasksNotRecorded) != (b.Key == tasksNotRecorded) {
			return b.Key == tasksNotRecorded // "Not recorded" last
		}
		if a.Completed != b.Completed {
			return a.Completed > b.Completed
		}
		return a.Label < b.Label
	})
	writeJSON(w, http.StatusOK, ans)
}
