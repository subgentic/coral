package routes

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/efficiency"
	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/store"
)

// The Analytics view's efficiency measures (#8915, Goal #77): tokens per commit and the median task time (claim to done, review not counted), grouped by provider, model, thinking level, team, agent, branch
// or task. One read:
//
//	GET /api/analytics/efficiency?metric=tokens_per_commit|task_time&group_by=provider|model|thinking|team|agent|branch|task&range=24h|7d|30d[&team=<board>]
//
// NEVER through Coral Hub for now (no row in the tunnel table, a census line): it names agents and counts their work. The rules of what is attributed to what are internal/efficiency's package comment.
// A thinking level is recorded on usage rows and task claims from #8915 on; everything older groups under "Not recorded".

// EfficiencyHandler serves the efficiency read.
type EfficiencyHandler struct {
	ts  *store.TokenUsageStore
	ss  *store.SessionStore
	bs  *board.Store
	now func() time.Time
}

// NewEfficiencyHandler creates the handler.
func NewEfficiencyHandler(db *store.DB, bs *board.Store) *EfficiencyHandler {
	return &EfficiencyHandler{ts: store.NewTokenUsageStore(db), ss: store.NewSessionStore(db), bs: bs}
}

func (h *EfficiencyHandler) clock() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

// efficiencyRanges are the windows a read may ask for; "the usual" is the same figure over the seven days before the window.
var efficiencyRanges = map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}

const (
	efficiencyUsual       = 7 * 24 * time.Hour
	efficiencyCommitSlack = 14 * 24 * time.Hour // commits are read this far before a window, so a task claimed before it still has its commits
)

type efficiencyAverage struct {
	Value *float64 `json:"value,omitempty"`
	Usual *float64 `json:"usual,omitempty"`
}

type efficiencyAnswer struct {
	Metric      string             `json:"metric"`
	GroupBy     string             `json:"group_by"`
	Range       string             `json:"range"`
	GeneratedAt string             `json:"generated_at"`
	MinSample   int                `json:"min_sample"`
	Total       efficiency.Total   `json:"total"`
	Average     efficiencyAverage  `json:"average"`
	Groups      []efficiency.Group `json:"groups"`
	Unmeasured  []string           `json:"unmeasured"`
}

// Efficiency answers the read.
func (h *EfficiencyHandler) Efficiency(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	metric, dim, rng := q.Get("metric"), q.Get("group_by"), q.Get("range")
	if rng == "" {
		rng = "7d"
	}
	if !efficiency.ValidMetric(metric) {
		errBadRequest(w, "metric must be tokens_per_commit or task_time")
		return
	}
	if !efficiency.ValidDim(dim) {
		errBadRequest(w, "group_by must be one of "+efficiency.Dims())
		return
	}
	dur, ok := efficiencyRanges[rng]
	if !ok {
		errBadRequest(w, "range must be 24h, 7d or 30d")
		return
	}
	team := strings.TrimSpace(q.Get("team"))
	now := h.clock()
	since := now.Add(-dur)
	ctx := r.Context()
	in, err := h.input(ctx, since, now, team)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	cur, err := efficiency.Compute(metric, dim, in)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	prevIn, err := h.input(ctx, since.Add(-efficiencyUsual), since, team)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	prev, _ := efficiency.Compute(metric, dim, prevIn)
	groups := cur.Groups
	if groups == nil {
		groups = []efficiency.Group{}
	}
	writeJSON(w, http.StatusOK, efficiencyAnswer{
		Metric: metric, GroupBy: dim, Range: rng, GeneratedAt: now.Format(time.RFC3339), MinSample: efficiency.MinSample,
		Total: cur.Total, Average: efficiencyAverage{Value: cur.Average, Usual: prev.Average}, Groups: groups, Unmeasured: cur.Unmeasured,
	})
}

// measuredProviders are the CLIs whose usage Coral reads (the same set as the Spend read): Gemini writes no usage rows.
var measuredProviders = map[string]bool{"claude": true, "codex": true, "pi": true, "agy": true}

// input reads one window [from, to) and shapes it for efficiency.Compute. team, when set, keeps one board's rows only.
func (h *EfficiencyHandler) input(ctx context.Context, from, to time.Time, team string) (efficiency.Input, error) {
	in := efficiency.Input{Measured: measuredProviders, Sessions: map[string]efficiency.Session{}, TeamLabels: map[string]string{}}
	usage, err := h.ts.EfficiencyUsage(ctx, from.Format(time.RFC3339), to.Format(time.RFC3339))
	if err != nil {
		return in, err
	}
	live, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		return in, err
	}
	branches, err := h.ss.LatestBranches(ctx)
	if err != nil {
		return in, err
	}
	liveByID := make(map[string]store.LiveSession, len(live))
	for _, ls := range live {
		liveByID[ls.SessionID] = ls
	}
	// every session that shows up (a usage row, a commit, a task's claimer) gets its labels from its live row, else from the row that named it
	addSession := func(id, agent, provider, boardName string) {
		if id == "" {
			return
		}
		s := in.Sessions[id]
		s.ID = id
		if ls, ok := liveByID[id]; ok {
			if s.Agent == "" {
				s.Agent = firstNonEmptyStr(deref(ls.DisplayName), ls.AgentName)
			}
			if s.Provider == "" {
				s.Provider = ls.AgentType
			}
			if s.Team == "" {
				s.Team = deref(ls.BoardName)
			}
		}
		if s.Agent == "" {
			s.Agent = agent
		}
		if s.Provider == "" {
			s.Provider = provider
		}
		if s.Team == "" {
			s.Team = boardName
		}
		s.Branch = branches[id]
		in.Sessions[id] = s
	}
	for _, u := range usage {
		if team != "" && u.Team != team {
			continue
		}
		addSession(u.SessionID, u.AgentName, u.AgentType, u.Team)
		in.Usage = append(in.Usage, efficiency.UsageRow{Session: u.SessionID, Provider: u.AgentType, Team: u.Team, Model: u.Model, Thinking: u.Thinking, Tokens: u.Tokens, CostUSD: u.CostUSD})
	}
	dominantModel := dominantModels(in.Usage)

	commits, err := h.ss.EfficiencyCommits(ctx, from.Add(-efficiencyCommitSlack), to)
	if err != nil {
		return in, err
	}
	type timed struct {
		session string
		at      time.Time
	}
	var commitTimes []timed
	for _, c := range commits {
		ls, isLive := liveByID[c.SessionID]
		if isLive {
			if started, err := time.Parse(time.RFC3339, ls.CreatedAt); err == nil && c.At.Before(started.Add(-time.Minute)) {
				continue // made before the session began: the agent found it there
			}
		}
		addSession(c.SessionID, c.AgentName, c.AgentType, "")
		if team != "" && in.Sessions[c.SessionID].Team != team {
			continue
		}
		commitTimes = append(commitTimes, timed{c.SessionID, c.At})
		if !c.At.Before(from) {
			in.Commits = append(in.Commits, efficiency.Commit{Hash: c.Hash, Session: c.SessionID, Branch: c.Branch})
		}
	}

	tasks, err := h.bs.EfficiencyTasks(ctx, from.Format("2006-01-02T15:04:05Z"), to.Format("2006-01-02T15:04:05Z"))
	if err != nil {
		return in, err
	}
	subscribers, err := h.bs.SubscriberSessions(ctx)
	if err != nil {
		return in, err
	}
	for _, t := range tasks {
		if team != "" && t.Board != team {
			continue
		}
		var provider, sid string
		if name := subscribers[t.Board+"|"+t.Claimer]; name != "" {
			provider, sid = logparse.ParseSessionName(name)
		}
		addSession(sid, t.Claimer, provider, t.Board)
		row := efficiency.TaskRow{ID: t.ID, Title: t.Title, Team: t.Board, Agent: t.Claimer, Provider: provider, Thinking: t.Thinking, Branch: branches[sid],
			WorkSeconds: t.WorkSeconds, SentBack: t.SentBack, Tokens: t.Tokens, CostUSD: t.CostUSD}
		if m, ok := dominantModel[sid]; ok {
			row.Model = m
		} else if ls, ok := liveByID[sid]; ok {
			row.Model = deref(ls.Model)
		}
		claimed, errClaimed := time.Parse(time.RFC3339, t.ClaimedAt)
		ended, errEnded := time.Parse(time.RFC3339, t.EndedAt)
		if sid != "" && errClaimed == nil && errEnded == nil {
			for _, c := range commitTimes {
				if c.session == sid && !c.at.Before(claimed) && !c.at.After(ended) {
					row.Commits++
				}
			}
		}
		in.Tasks = append(in.Tasks, row)
	}
	teams := map[string]bool{}
	for _, s := range in.Sessions {
		if s.Team != "" {
			teams[s.Team] = true
		}
	}
	for _, t := range in.Tasks {
		teams[t.Team] = true
	}
	ids := make([]string, 0, len(teams))
	for id := range teams {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	in.TeamLabels = h.bs.BoardLabels(ctx, ids)
	return in, nil
}

// dominantModels is each session's model that spent most of its tokens in the rows (ties: the smaller name); a session whose rows name no model is left out.
func dominantModels(rows []efficiency.UsageRow) map[string]string {
	by := map[string]map[string]int64{}
	for _, r := range rows {
		if r.Model == "" {
			continue
		}
		if by[r.Session] == nil {
			by[r.Session] = map[string]int64{}
		}
		by[r.Session][r.Model] += r.Tokens
	}
	out := map[string]string{}
	for s, m := range by {
		best, bestT := "", int64(-1)
		for k, v := range m {
			if v > bestT || (v == bestT && k < best) {
				best, bestT = k, v
			}
		}
		out[s] = best
	}
	return out
}

func firstNonEmptyStr(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
