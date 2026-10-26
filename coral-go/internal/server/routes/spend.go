package routes

import (
	"context"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/landedcommits"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// The Analytics view's data for one team (#7525): tokens, commits that reached main, tool calls and task times for a board, over a window and the seven days before it ("the usual"). One read:
// GET /api/board/{project}/spend?range=24h|7d. NEVER through Coral Hub for now (no row in the tunnel table, a census line): it names agents and counts their work.
//
// Tokens are measured for Claude, Codex, Pi and agy (the token poller reads their transcripts) and not for Gemini, which writes no rows: those agents are null, never zero. Tool calls come from the
// tool_use events the hooks record (Claude, Codex, agy), not Gemini or Pi. Commits are read from the repository's own history (internal/landedcommits): the board's live agents' most common git root and
// the repository's default branch, the author name is the agent, a commit that matches no agent is "Unattributed". Task times are what the board stores (store: board/task_times.go).

// SpendHandler serves the spend read.
type SpendHandler struct {
	db      *store.DB
	ts      *store.TokenUsageStore
	ss      *store.SessionStore
	bs      *board.Store
	commits landedcommits.Cache
	now     func() time.Time
}

// NewSpendHandler creates the handler.
func NewSpendHandler(db *store.DB, bs *board.Store) *SpendHandler {
	return &SpendHandler{db: db, ts: store.NewTokenUsageStore(db), ss: store.NewSessionStore(db), bs: bs}
}

func (h *SpendHandler) clock() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

// tokenSources and toolSources are the CLIs that have a source for each measure.
var (
	tokenSources = map[string]bool{agenttypes.Claude: true, agenttypes.Codex: true, agenttypes.Pi: true, agenttypes.Agy: true}
	toolSources  = map[string]bool{agenttypes.Claude: true, agenttypes.Codex: true, agenttypes.Agy: true}
)

type spendTokens struct {
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite *int64 `json:"cache_write"` // null when no agent reports a cache write (Codex does not)
}

type spendSeriesPoint struct {
	Day        string `json:"day,omitempty"`  // per_day: 2026-10-25
	Hour       string `json:"hour,omitempty"` // per_hour: 2026-10-25T14:00:00Z
	Tokens     int64  `json:"tokens"`         // input + output, the same everywhere; cache reads and writes are beside it
	CacheRead  int64  `json:"cache_read"`
	CacheWrite *int64 `json:"cache_write"` // null when no agent reports a cache write
	Commits    *int   `json:"commits"`     // null when no repository was found
	ToolCalls  *int   `json:"tool_calls"`  // null when no agent has a source
	TasksDone  int    `json:"tasks_done"`
}

type spendAgent struct {
	Name              string   `json:"name"`
	Role              string   `json:"role"`
	Orchestrator      bool     `json:"orchestrator"`
	AgentType         string   `json:"agent_type"`
	SessionID         string   `json:"session_id,omitempty"`
	Measured          bool     `json:"measured"` // tokens
	Tokens            *int64   `json:"tokens"`
	Share             *float64 `json:"share"`
	CacheReads        *int64   `json:"cache_reads"`
	ToolCallsMeasured bool     `json:"tool_calls_measured"`
	ToolCalls         *int     `json:"tool_calls"`
	Commits           int      `json:"commits"`
	TasksDone         int      `json:"tasks_done"`
	WorkMedianS       *float64 `json:"work_median_s"`
}

type spendCommits struct {
	Available    bool           `json:"available"`
	Reason       string         `json:"reason,omitempty"`
	Repo         string         `json:"repo,omitempty"`   // the repository folder's name, not its path
	Branch       string         `json:"branch,omitempty"` // the default branch that was read
	Window       *int           `json:"window"`
	Usual        *int           `json:"usual"`
	Unattributed int            `json:"unattributed"`
	Capped       bool           `json:"capped"`
	QueueLanded  map[string]int `json:"queue_landed"` // merge-queue landed_by: commits each person marked landed in the window (extra detail)
}

type spendToolCalls struct {
	Window         *int `json:"window"`
	Usual          *int `json:"usual"`
	MeasuredAgents int  `json:"measured_agents"`
	OfAgents       int  `json:"of_agents"`
}

type spendTaskAgent struct {
	Name     string   `json:"name"`
	Done     int      `json:"done"`
	Median   *float64 `json:"median_s,omitempty"`
	SentBack int      `json:"sent_back"`
}

type spendTaskPoint struct {
	Day  string `json:"day,omitempty"`
	Hour string `json:"hour,omitempty"`
	Done int    `json:"done"`
}

// spendTaskTime is the task-time block (#7525, the page's #7530): seconds everywhere; a measure no task could answer has no key (never 0).
type spendTaskTime struct {
	Window      board.TaskTimeStats `json:"window"`
	Usual       board.TaskTimeStats `json:"usual"`
	PerHour     []spendTaskPoint    `json:"per_hour,omitempty"` // range 24h
	PerDay      []spendTaskPoint    `json:"per_day,omitempty"`  // range 7d
	Agents      []spendTaskAgent    `json:"agents"`
	ReviewLabel string              `json:"review_label"`
}

type spendResponse struct {
	Board          string                 `json:"board"`
	Range          string                 `json:"range"`
	RangeHours     int                    `json:"range_hours"`
	GeneratedAt    string                 `json:"generated_at"`
	WindowStart    string                 `json:"window_start"`
	WindowEnd      string                 `json:"window_end"`
	Tokens         map[string]spendTokens `json:"tokens"` // window, usual
	Commits        spendCommits           `json:"commits"`
	ToolCalls      spendToolCalls         `json:"tool_calls"`
	TaskTime       spendTaskTime          `json:"task_time"`
	PerHour        []spendSeriesPoint     `json:"per_hour,omitempty"` // range=24h: 24 entries, oldest first
	PerDay         []spendSeriesPoint     `json:"per_day,omitempty"`  // range=7d: 7 entries, oldest first
	Agents         []spendAgent           `json:"agents"`
	MeasuredAgents int                    `json:"measured_agents"`
	OfAgents       int                    `json:"of_agents"`
}

const spendReviewLabel = "review time (from assignment to approval)"

// spendFrame is the time the read is about: the window, and the seven days before it ("the usual"). A 24 h window is whole hours ending at the next hour; a 7 d window is whole UTC days ending tonight.
type spendFrame struct {
	rng                         string
	hourly                      bool // range 24h
	hours                       int
	now, start, end, usualStart time.Time
}

func newSpendFrame(rng string, now time.Time) spendFrame {
	fr := spendFrame{rng: rng, hourly: rng == "24h", now: now}
	if fr.hourly {
		fr.end = now.Truncate(time.Hour).Add(time.Hour)
		fr.hours = 24
		fr.start = fr.end.Add(-24 * time.Hour)
	} else {
		day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		fr.end = day.Add(24 * time.Hour)
		fr.hours = 7 * 24
		fr.start = fr.end.Add(-7 * 24 * time.Hour)
	}
	fr.usualStart = fr.start.Add(-7 * 24 * time.Hour)
	return fr
}

// spendStamp is a time in the replies and in the token store's queries (RFC 3339); spendDBStamp is the form the event table keeps.
func spendStamp(t time.Time) string   { return t.UTC().Format(time.RFC3339) }
func spendDBStamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05") }

// spendRange reads the one query parameter the read takes, and answers a bad request itself.
func spendRange(w http.ResponseWriter, r *http.Request) (string, bool) {
	rng := r.URL.Query().Get("range")
	if rng == "" {
		rng = "24h"
	}
	for k := range r.URL.Query() {
		if k != "range" {
			errBadRequest(w, "this read takes range only")
			return "", false
		}
	}
	if rng != "24h" && rng != "7d" {
		errBadRequest(w, "range is 24h or 7d")
		return "", false
	}
	return rng, true
}

// spendAgentAcc is one agent of the board with what the token store knows of it in the window.
type spendAgentAcc struct {
	sess store.LiveSession
	sum  *store.AgentUsageSummary
}

// spendRoster is the board's agents in the order they are found, and the roles members have on the board.
type spendRoster struct {
	order  []string
	accs   map[string]*spendAgentAcc
	roleOf map[string]string // terminal name -> the role name on the board
	orchOf map[string]bool   // terminal name -> the member is an orchestrator (it lands no commits of its own: the page says "team")
}

// readRoster reads the board's agents: its live sessions, and any session that has token rows in the window (an ended one), then the roles. A failed read comes back as the words of the 500 ("" when it worked).
func (h *SpendHandler) readRoster(ctx context.Context, project string, fr spendFrame) (*spendRoster, string) {
	sessions, err := h.ss.GetBoardSessions(ctx, project)
	if err != nil {
		return nil, "could not read the board's agents"
	}
	summaries, err := h.ts.GetUsageSummaryByAgentBoard(ctx, spendStamp(fr.start), project)
	if err != nil {
		return nil, "could not read token usage"
	}
	ro := &spendRoster{accs: map[string]*spendAgentAcc{}, roleOf: map[string]string{}, orchOf: map[string]bool{}}
	subs, _ := h.bs.ListSubscribers(ctx, project)
	for _, s := range subs {
		if s.SessionName != "" {
			ro.roleOf[s.SessionName] = s.SubscriberID
			ro.orchOf[s.SessionName] = s.CanPeek != 0
		}
	}
	for _, s := range sessions {
		ro.accs[s.SessionID] = &spendAgentAcc{sess: s}
		ro.order = append(ro.order, s.SessionID)
	}
	for i := range summaries {
		s := &summaries[i]
		if a, ok := ro.accs[s.SessionID]; ok {
			a.sum = s
			continue
		}
		ro.accs[s.SessionID] = &spendAgentAcc{sess: store.LiveSession{SessionID: s.SessionID, AgentType: s.AgentType, AgentName: s.Folder, WorkingDir: s.WorkingDir}, sum: s}
		ro.order = append(ro.order, s.SessionID)
	}
	return ro, ""
}

// Spend answers GET /api/board/{project}/spend?range=24h|7d.
func (h *SpendHandler) Spend(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	project := urlParam(r, "project")
	rng, ok := spendRange(w, r)
	if !ok {
		return
	}
	id, _, err := h.bs.ResolveBoard(r.Context(), project) // an id, or a label that names one board
	if err != nil {
		errNotFound(w, "no such board")
		return
	}
	project = id

	now := h.clock()
	fr := newSpendFrame(rng, now)
	start, end, usualStart, hours, hourly := fr.start, fr.end, fr.usualStart, fr.hours, fr.hourly
	ctx := r.Context()
	f, g := spendStamp, spendDBStamp

	roster, fail := h.readRoster(ctx, project, fr)
	if fail != "" {
		errInternalServer(w, fail)
		return
	}
	accs, order, roleOf, orchOf := roster.accs, roster.order, roster.roleOf, roster.orchOf
	buckets, err := h.ts.GetUsageTimeSeriesBoard(ctx, f(usualStart), "1h", project)
	if err != nil {
		errInternalServer(w, "could not read token usage")
		return
	}

	// tokens, window against the usual, from the hourly buckets
	win, usual := spendTokens{}, spendTokens{}
	var winCW, usualCW int64
	hourTokens, hourCache, hourCW := map[string]int64{}, map[string]int64{}, map[string]int64{} // by hour, "2006-01-02T15", for both series
	for _, b := range buckets {
		t, err := time.Parse(time.RFC3339, b.Bucket)
		if err != nil || !t.Before(end) {
			continue
		}
		key := t.Format("2006-01-02T15")
		hourTokens[key] += b.InputTokens + b.OutputTokens
		hourCache[key] += b.CacheReadTokens
		hourCW[key] += b.CacheWriteTokens
		acc := &usual
		cw := &usualCW
		if !t.Before(start) {
			acc, cw = &win, &winCW
		}
		acc.Input += b.InputTokens
		acc.Output += b.OutputTokens
		acc.CacheRead += b.CacheReadTokens
		*cw += b.CacheWriteTokens
	}
	if winCW > 0 || usualCW > 0 {
		win.CacheWrite, usual.CacheWrite = &winCW, &usualCW
	}

	// tool calls
	var toolSessions []string
	for _, id := range order {
		if toolSources[accs[id].sess.AgentType] {
			toolSessions = append(toolSessions, id)
		}
	}
	const bucketLen = 13 // hourly always: the day series is made from the hours
	var toolRows []store.ToolCallBucket
	if len(toolSessions) > 0 {
		if toolRows, err = h.db.ToolCallBuckets(ctx, toolSessions, g(usualStart), g(end), bucketLen); err != nil {
			errInternalServer(w, "could not read tool calls")
			return
		}
	}
	toolWin, toolUsual := 0, 0
	toolBySession := map[string]int{}
	toolByBucket := map[string]int{}
	for _, row := range toolRows {
		bt := row.Bucket
		t, perr := time.Parse("2006-01-02T15", bt)
		if perr != nil {
			continue
		}
		toolByBucket[bt] += row.N
		if t.Before(start) { // the start is hour-aligned like the buckets
			toolUsual += row.N
			continue
		}
		toolWin += row.N
		toolBySession[row.SessionID] += row.N
	}

	// commits from main's history
	var dirs []string
	for _, id := range order {
		dirs = append(dirs, accs[id].sess.WorkingDir)
	}
	commitInfo := spendCommits{QueueLanded: map[string]int{}}
	var winCommits, usualCommits []landedcommits.Commit
	if root := landedcommits.CommonRoot(ctx, dirs); root == "" {
		commitInfo.Reason = "no repository found for this board's agents"
	} else if branch := landedcommits.DefaultBranch(ctx, root); branch == "" {
		commitInfo.Reason = "the repository has no main branch (origin/HEAD, main or master)"
		commitInfo.Repo = filepath.Base(root)
	} else {
		all, capped, err := h.commits.Read(ctx, root, branch, usualStart, end)
		if err != nil {
			commitInfo.Reason = "the repository's history could not be read"
		} else {
			commitInfo.Available, commitInfo.Repo, commitInfo.Branch, commitInfo.Capped = true, filepath.Base(root), branch, capped
			for _, c := range all {
				if t, perr := time.Parse(time.RFC3339, c.At); perr == nil && !t.Before(start) {
					winCommits = append(winCommits, c)
				} else {
					usualCommits = append(usualCommits, c)
				}
			}
			wn, un := len(winCommits), len(usualCommits)
			commitInfo.Window, commitInfo.Usual = &wn, &un
		}
	}
	if landed, err := h.bs.LandedSince(ctx, project, f(start), 0); err == nil {
		seen := map[string]bool{}
		for _, l := range landed {
			if !seen[l.SHA] {
				seen[l.SHA] = true
				commitInfo.QueueLanded[l.LandedBy]++
			}
		}
	}

	// which agent each commit's author is
	nameKey := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	byName := map[string]string{} // lower-case name -> session id
	for _, id := range order {
		a := accs[id]
		for _, n := range []string{displayOf(a.sess), roleOf[naming.SessionName(a.sess.AgentType, id)], a.sess.AgentName} {
			if k := nameKey(n); k != "" {
				if _, ok := byName[k]; !ok {
					byName[k] = id
				}
			}
		}
	}
	commitsBy := map[string]int{}
	hourCommits := map[string]int{}
	for _, c := range winCommits {
		if id, ok := byName[nameKey(c.Author)]; ok {
			commitsBy[id]++
		} else {
			commitInfo.Unattributed++
		}
	}
	for _, c := range append(append([]landedcommits.Commit(nil), winCommits...), usualCommits...) {
		if t, err := time.Parse(time.RFC3339, c.At); err == nil {
			hourCommits[t.Format("2006-01-02T15")]++
		}
	}

	// task times
	winTasks, err := h.bs.TasksCompletedBetween(ctx, project, f(start), f(end))
	usualTasks, err2 := h.bs.TasksCompletedBetween(ctx, project, f(usualStart), f(start))
	if err != nil || err2 != nil {
		errInternalServer(w, "could not read task times")
		return
	}
	tasksByAgent := map[string][]board.TaskTime{}
	tasksByBucket := map[string]int{}
	for _, tt := range winTasks {
		tasksByAgent[nameKey(tt.CompletedBy)] = append(tasksByAgent[nameKey(tt.CompletedBy)], tt)
	}
	for _, tt := range append(append([]board.TaskTime(nil), winTasks...), usualTasks...) {
		if t, perr := time.Parse(time.RFC3339, tt.CompletedAt); perr == nil {
			tasksByBucket[t.Format("2006-01-02T15")]++
		}
	}

	// the agents
	total := int64(0)
	for _, id := range order {
		if a := accs[id]; a.sum != nil && tokenSources[a.sess.AgentType] {
			total += a.sum.InputTokens + a.sum.OutputTokens
		}
	}
	resp := spendResponse{Board: project, Range: rng, RangeHours: hours, GeneratedAt: f(now), WindowStart: f(start), WindowEnd: f(end),
		Tokens: map[string]spendTokens{"window": win, "usual": usual}, Commits: commitInfo, OfAgents: len(order)}
	toolMeasured := 0
	for _, id := range order {
		a := accs[id]
		term := naming.SessionName(a.sess.AgentType, id)
		row := spendAgent{Name: displayOf(a.sess), AgentType: a.sess.AgentType, SessionID: id, Role: roleOf[term], Orchestrator: orchOf[term]}
		if row.Name == "" {
			row.Name = row.Role
		}
		if row.Name == "" {
			row.Name = "Agent"
		}
		if tokenSources[a.sess.AgentType] {
			row.Measured = true
			resp.MeasuredAgents++
			var tok, cr int64
			if a.sum != nil {
				tok = a.sum.InputTokens + a.sum.OutputTokens
				cr = a.sum.CacheReadTokens
			}
			row.Tokens, row.CacheReads = &tok, &cr
			share := 0.0
			if total > 0 {
				share = float64(tok) / float64(total)
			}
			row.Share = &share
		}
		if toolSources[a.sess.AgentType] {
			row.ToolCallsMeasured = true
			toolMeasured++
			n := toolBySession[id]
			row.ToolCalls = &n
		}
		row.Commits = commitsBy[id]
		var mine []board.TaskTime
		for _, k := range []string{nameKey(row.Name), nameKey(row.Role), nameKey(a.sess.AgentName)} {
			if k != "" {
				mine = append(mine, tasksByAgent[k]...)
				delete(tasksByAgent, k)
			}
		}
		st := board.SummarizeTaskTimes(mine)
		row.TasksDone, row.WorkMedianS = st.Done, st.WorkMedian
		resp.Agents = append(resp.Agents, row)
	}
	if commitInfo.Unattributed > 0 {
		resp.Agents = append(resp.Agents, spendAgent{Name: "Unattributed", Commits: commitInfo.Unattributed})
	}
	sort.SliceStable(resp.Agents, func(i, j int) bool {
		a, b := resp.Agents[i].Tokens, resp.Agents[j].Tokens
		switch {
		case a != nil && b != nil:
			return *a > *b
		case a != nil:
			return true
		}
		return false
	})
	tc := spendToolCalls{MeasuredAgents: toolMeasured, OfAgents: len(order)}
	if toolMeasured > 0 {
		tc.Window, tc.Usual = &toolWin, &toolUsual
	}
	resp.ToolCalls = tc
	resp.TaskTime = spendTaskTime{Window: board.SummarizeTaskTimes(winTasks), Usual: board.SummarizeTaskTimes(usualTasks), ReviewLabel: spendReviewLabel, Agents: []spendTaskAgent{}}
	byCompleter := map[string][]board.TaskTime{}
	displayOfKey := map[string]string{}
	for _, tt := range winTasks {
		k := nameKey(tt.CompletedBy)
		byCompleter[k] = append(byCompleter[k], tt)
		if _, ok := displayOfKey[k]; !ok {
			displayOfKey[k] = strings.TrimSpace(tt.CompletedBy)
		}
	}
	for k, tts := range byCompleter {
		if k == "" {
			continue
		}
		st := board.SummarizeTaskTimes(tts)
		resp.TaskTime.Agents = append(resp.TaskTime.Agents, spendTaskAgent{Name: displayOfKey[k], Done: st.Done, Median: st.WorkMedian, SentBack: st.WentBack2Plus})
	}
	sort.Slice(resp.TaskTime.Agents, func(i, j int) bool {
		a, b := resp.TaskTime.Agents[i], resp.TaskTime.Agents[j]
		if a.Done != b.Done {
			return a.Done > b.Done
		}
		return a.Name < b.Name
	})

	// the series, oldest first: an hour's point is its own hour; a day's is the sum of its 24 hours
	cwReported := winCW > 0 || usualCW > 0
	pointOf := func(hours []time.Time) spendSeriesPoint {
		var p spendSeriesPoint
		var cw int64
		commits, tools := 0, 0
		for _, t := range hours {
			key := t.Format("2006-01-02T15")
			p.Tokens += hourTokens[key]
			p.CacheRead += hourCache[key]
			cw += hourCW[key]
			p.TasksDone += tasksByBucket[key]
			commits += hourCommits[key]
			tools += toolByBucket[key]
		}
		if cwReported {
			p.CacheWrite = &cw
		}
		if commitInfo.Available {
			p.Commits = &commits
		}
		if toolMeasured > 0 {
			p.ToolCalls = &tools
		}
		return p
	}
	dayPoints := func(first, until time.Time) {
		for d := first; d.Before(until); d = d.Add(24 * time.Hour) {
			var hs []time.Time
			for h := 0; h < 24; h++ {
				hs = append(hs, d.Add(time.Duration(h)*time.Hour))
			}
			p := pointOf(hs)
			p.Day = d.Format("2006-01-02")
			resp.PerDay = append(resp.PerDay, p)
			resp.TaskTime.PerDay = append(resp.TaskTime.PerDay, spendTaskPoint{Day: p.Day, Done: p.TasksDone})
		}
	}
	if hourly {
		for t := start; t.Before(end); t = t.Add(time.Hour) {
			p := pointOf([]time.Time{t})
			p.Hour = t.Format(time.RFC3339)
			resp.PerHour = append(resp.PerHour, p)
			resp.TaskTime.PerHour = append(resp.TaskTime.PerHour, spendTaskPoint{Hour: p.Hour, Done: p.TasksDone})
		}
		// the 24 h view's chart is a bar a day for the week: the six days before today and today, whole UTC days (today's still running)
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		dayPoints(today.Add(-6*24*time.Hour), today.Add(24*time.Hour))
	} else {
		dayPoints(start, end)
	}
	writeJSON(w, http.StatusOK, resp)
}

// displayOf is a live session's name for people: its display name, else its folder name.
func displayOf(s store.LiveSession) string {
	if s.DisplayName != nil && strings.TrimSpace(*s.DisplayName) != "" {
		return strings.TrimSpace(*s.DisplayName)
	}
	return s.AgentName
}
