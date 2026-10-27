package routes

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/efficiency"
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
	efficiencyCommitSlack = 14 * 24 * time.Hour // commits are read this far before a window, so a task claimed before it still has its commits; a task open longer than that has only the commits of its last 14 days before the window
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
	fail := func(err error) {
		slog.Error("efficiency read failed", "error", err) // the detail is the log's: a reply never carries a store's error text
		errInternalServer(w, "the efficiency read failed")
	}
	// what does not depend on the window is read once for both windows
	live, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		fail(err)
		return
	}
	branches, err := h.ss.LatestBranches(ctx)
	if err != nil {
		fail(err)
		return
	}
	shared := efficiencyShared{branches: branches, live: make(map[string]store.LiveSession, len(live))}
	for _, ls := range live {
		shared.live[ls.SessionID] = ls
	}
	// The commits of both windows are one read (the current window's reach back, and the usual's before it), and so are the facts of the sessions that made or saw them; each window then takes its own
	// from them. Two reads of the commit snapshots (which overlap by the slack's two weeks) were the cost of this route (#9151).
	shared.commits, err = h.ss.EfficiencyCommits(ctx, since.Add(-efficiencyUsual-efficiencyCommitSlack), now)
	if err != nil {
		fail(err)
		return
	}
	var commitSessions []string
	seenSession := map[string]bool{}
	for _, c := range shared.commits {
		for _, sg := range c.Seen {
			if sg.SessionID != "" && !seenSession[sg.SessionID] {
				seenSession[sg.SessionID] = true
				commitSessions = append(commitSessions, sg.SessionID)
			}
		}
	}
	if shared.facts, err = h.ss.SessionFacts(ctx, commitSessions); err != nil {
		fail(err)
		return
	}
	in, err := h.input(ctx, since, now, team, shared, dim != efficiency.Thinking)
	if err != nil {
		fail(err)
		return
	}
	cur, err := efficiency.Compute(metric, dim, in)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	prevIn, err := h.input(ctx, since.Add(-efficiencyUsual), since, team, shared, dim != efficiency.Thinking)
	if err != nil {
		fail(err)
		return
	}
	prev, _ := efficiency.Compute(metric, dim, prevIn)
	groups := cur.Groups
	if groups == nil {
		groups = []efficiency.Group{}
	}
	writeJSON(w, http.StatusOK, efficiencyAnswer{
		Metric: metric, GroupBy: dim, Range: rng, GeneratedAt: now.Format(time.RFC3339), MinSample: efficiency.MinSample,
		Total: cur.Total, Average: efficiencyAverage{Value: cur.Median, Usual: prev.Median}, Groups: groups, Unmeasured: cur.Unmeasured,
	})
}

// measuredProviders are the CLIs whose usage Coral reads (the same set as the Spend read): Gemini writes no usage rows.
var measuredProviders = map[string]bool{"claude": true, "codex": true, "pi": true, "agy": true}

// efficiencyShared is what both windows of one read share.
type efficiencyShared struct {
	live     map[string]store.LiveSession
	branches map[string]string
	commits  []store.EfficiencyCommit      // every commit of both windows and the slack before them, once
	facts    map[string]store.SessionFacts // the sessions that made or saw those commits
}

// foundThere is how long before a session began a commit may be dated and still be the session's own (clock slack): an earlier one was already on the branch when the agent started.
const foundThere = time.Minute

// input reads one window [from, to) and shapes it for efficiency.Compute. team, when set, keeps one board's rows only.
// coarse: the grouping does not read the thinking level of the usage rows (every grouping but thinking: the commits' dominant level is only the thinking grouping's), so the usage is read from the day aggregate (#9442).
func (h *EfficiencyHandler) input(ctx context.Context, from, to time.Time, team string, sh efficiencyShared, coarse bool) (efficiency.Input, error) {
	in := efficiency.Input{Measured: measuredProviders, Sessions: map[string]efficiency.Session{}, TeamLabels: map[string]string{}}
	usage, err := h.ts.EfficiencyUsage(ctx, from.Format(time.RFC3339), to.Format(time.RFC3339), coarse)
	if err != nil {
		return in, err
	}
	// this window's commits: those dated from the slack before it up to its end, out of the one read
	var commits []store.EfficiencyCommit
	for _, c := range sh.commits {
		if !c.At.Before(from.Add(-efficiencyCommitSlack)) && c.At.Before(to) {
			commits = append(commits, c)
		}
	}
	tasks, err := h.bs.EfficiencyTasks(ctx, from.Format(time.RFC3339), to.Format(time.RFC3339))
	if err != nil {
		return in, err
	}
	// the facts of the commits' sessions are shared; a task's session that is not among them is asked for here (a live row has the facts itself)
	facts := make(map[string]store.SessionFacts, len(sh.facts))
	for id, f := range sh.facts {
		facts[id] = f
	}
	var wantFacts []string
	for _, t := range tasks {
		if _, known := facts[t.Session]; t.Session != "" && !known {
			wantFacts = append(wantFacts, t.Session)
			facts[t.Session] = store.SessionFacts{} // asked once, whatever the answer
		}
	}
	more, err := h.ss.SessionFacts(ctx, wantFacts)
	if err != nil {
		return in, err
	}
	for id, f := range more {
		facts[id] = f
	}
	// every session that shows up (a usage row, a commit, a task's claim) gets its labels from its live row, else from the row that named it
	addSession := func(id, agent, provider, boardName string) {
		if id == "" {
			return
		}
		s := in.Sessions[id]
		s.ID = id
		if ls, ok := sh.live[id]; ok {
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
		if s.Provider == "" {
			s.Provider = facts[id].Provider
		}
		if s.Team == "" {
			s.Team = boardName
		}
		s.Branch = sh.branches[id]
		in.Sessions[id] = s
	}
	for _, u := range usage {
		if team != "" && u.Team != team {
			continue
		}
		addSession(u.SessionID, u.AgentName, u.AgentType, u.Team)
		in.Usage = append(in.Usage, efficiency.UsageRow{Session: u.SessionID, Provider: u.AgentType, Team: u.Team, Model: u.Model, Thinking: u.Thinking, Tokens: u.Tokens, CostUSD: u.CostUSD})
	}
	dominantModel := efficiency.DominantModels(in.Usage)

	// A commit belongs to the first session that saw it, had begun by then and is the author's (by its git identity; a commit whose author was not recorded can be anyone's): one that started after the commit was dated found it on the branch (a session that is not known to have begun is taken to have
	// begun before it).
	type timed struct {
		session string
		at      time.Time
		hash    string
	}
	bySession := map[string][]timed{}
	for _, c := range commits {
		var owner *store.CommitSighting
		for i := range c.Seen {
			sg := &c.Seen[i]
			start := sh.sessionStart(sg.SessionID, facts)
			if !start.IsZero() && c.At.Before(start.Add(-foundThere)) {
				continue
			}
			if !c.MadeBy(*sg, deref(sh.live[sg.SessionID].DisplayName)) {
				continue // someone else's commit that this session pulled in
			}
			owner = sg
			break
		}
		if owner == nil {
			continue
		}
		addSession(owner.SessionID, owner.AgentName, owner.AgentType, "")
		if team != "" && in.Sessions[owner.SessionID].Team != team {
			continue
		}
		bySession[owner.SessionID] = append(bySession[owner.SessionID], timed{owner.SessionID, c.At, c.Hash})
		if !c.At.Before(from) {
			in.Commits = append(in.Commits, efficiency.Commit{Hash: c.Hash, Session: owner.SessionID, Branch: owner.Branch})
		}
	}

	// A task is the work of the session recorded at its claim, which a restart of the agent since does not change; one with none recorded has no session, no provider and no commits. Its commits are those
	// made in any round of its work (a send-back keeps each earlier round's claim and hand-in), as its tokens and time are.
	type window struct {
		claimed, ended time.Time
		row            int
	}
	windows := map[string][]window{}
	for _, t := range tasks {
		if team != "" && t.Board != team {
			continue
		}
		var provider string
		if t.Session != "" {
			addSession(t.Session, t.Claimer, "", t.Board)
			provider = in.Sessions[t.Session].Provider
		}
		row := efficiency.TaskRow{ID: t.ID, Title: t.Title, Team: t.Board, Agent: t.Claimer, Provider: provider, Thinking: t.Thinking, Branch: sh.branches[t.Session],
			WorkSeconds: t.WorkSeconds, SentBack: t.SentBack, Tokens: t.Tokens, CostUSD: t.CostUSD}
		if m, ok := dominantModel[t.Session]; ok {
			row.Model = m
		} else if ls, ok := sh.live[t.Session]; ok {
			row.Model = deref(ls.Model)
		}
		if t.Session != "" {
			for _, win := range t.Windows {
				claimed, errClaimed := time.Parse(time.RFC3339, win.Claimed)
				ended, errEnded := time.Parse(time.RFC3339, win.Ended)
				if errClaimed == nil && errEnded == nil {
					windows[t.Session] = append(windows[t.Session], window{claimed.UTC(), ended.UTC(), len(in.Tasks)})
				}
			}
		}
		in.Tasks = append(in.Tasks, row)
	}
	// each commit goes to one task: of its session's tasks that were open when it was made (from the claim, up to but not including the end), the one claimed last; the same instant, the higher number
	for sid, cs := range bySession {
		ws := windows[sid]
		for _, c := range cs {
			best := -1
			for i, w := range ws {
				if c.at.Before(w.claimed) || !c.at.Before(w.ended) {
					continue
				}
				if best < 0 || w.claimed.After(ws[best].claimed) || (w.claimed.Equal(ws[best].claimed) && in.Tasks[w.row].ID > in.Tasks[ws[best].row].ID) {
					best = i
				}
			}
			if best >= 0 {
				in.Tasks[ws[best].row].Commits++
			}
		}
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

// sessionStart is when a session began, from its live row, else the store's facts; zero when unknown.
func (sh efficiencyShared) sessionStart(id string, facts map[string]store.SessionFacts) time.Time {
	if ls, ok := sh.live[id]; ok {
		if t, err := time.Parse(time.RFC3339, ls.CreatedAt); err == nil {
			return t.UTC()
		}
	}
	return facts[id].Start
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
