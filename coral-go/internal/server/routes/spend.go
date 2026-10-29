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
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/landedcommits"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// The Analytics view's data for one team (#7525): tokens, commits that reached main, tool calls and task times for a board, over a window and the seven days before it ("the usual"). One read:
// GET /api/board/{project}/spend?range=24h|7d. NEVER through Coral Hub for now (no row in the tunnel table, a census line): it names agents and counts their work.
//
// Tokens are measured for Claude, Codex, Pi and agy (the token poller reads their transcripts) and not for Gemini, which writes no rows: those agents are null, never zero. Tool calls come from the
// tool_use events the hooks record (Claude, Codex, agy) and, for Pi, which has no hooks, from the toolCall blocks of its session file (#11105); not Gemini. Commits are read from the repository's own history (internal/landedcommits): the board's live agents' most common git root and
// the repository's default branch, the author name is the agent, a commit that matches no agent is "Unattributed". Task times are what the board stores (store: board/task_times.go).

// SpendHandler serves the spend read.
type SpendHandler struct {
	db      *store.DB
	ts      *store.TokenUsageStore
	ss      *store.SessionStore
	bs      *board.Store
	commits landedcommits.Cache
	now     func() time.Time
	reader  *jsonl.SessionReader // the tool calls of a Pi session file are counted from it (#11105)
}

// NewSpendHandler creates the handler.
func NewSpendHandler(db *store.DB, bs *board.Store) *SpendHandler {
	return &SpendHandler{db: db, ts: store.NewTokenUsageStore(db), ss: store.NewSessionStore(db), bs: bs, reader: jsonl.NewSessionReader()}
}

// SetSessionReader shares the server's session reader (so a Pi session's file is read once for the chat, the state and these counts).
func (h *SpendHandler) SetSessionReader(r *jsonl.SessionReader) {
	if r != nil {
		h.reader = r
	}
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
	toolSources  = map[string]bool{agenttypes.Claude: true, agenttypes.Codex: true, agenttypes.Agy: true, agenttypes.Pi: true} // Pi has no hooks: its calls are counted from its session file (#11105)
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
	summaries, err := h.ts.GetUsageSummaryByAgentBoardUntil(ctx, spendStamp(fr.start), spendDBStamp(fr.end), project) // to the window's end, as the totals are
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

// spendTokenSeries is the board's tokens by hour (key "2006-01-02T15", for both series) and the window against the usual.
type spendTokenSeries struct {
	win, usual                    spendTokens
	winCW, usualCW                int64
	hourTokens, hourCache, hourCW map[string]int64
}

// readTokenSeries reads the board's hourly token buckets from the start of the usual period.
func (h *SpendHandler) readTokenSeries(ctx context.Context, project string, fr spendFrame) (*spendTokenSeries, string) {
	buckets, err := h.ts.GetUsageTimeSeriesBoard(ctx, spendStamp(fr.usualStart), "1h", project)
	if err != nil {
		return nil, "could not read token usage"
	}
	return bucketTokens(buckets, fr), ""
}

// bucketTokens sorts the hourly buckets into the window and the usual; a bucket at or after the window's end is left out. The cache write is null (nil) until some agent reports one.
func bucketTokens(buckets []store.TimeSeriesBucket, fr spendFrame) *spendTokenSeries {
	ts := &spendTokenSeries{hourTokens: map[string]int64{}, hourCache: map[string]int64{}, hourCW: map[string]int64{}}
	for _, b := range buckets {
		t, err := time.Parse(time.RFC3339, b.Bucket)
		if err != nil || !t.Before(fr.end) {
			continue
		}
		key := t.Format("2006-01-02T15")
		ts.hourTokens[key] += b.InputTokens + b.OutputTokens
		ts.hourCache[key] += b.CacheReadTokens
		ts.hourCW[key] += b.CacheWriteTokens
		acc := &ts.usual
		cw := &ts.usualCW
		if !t.Before(fr.start) {
			acc, cw = &ts.win, &ts.winCW
		}
		acc.Input += b.InputTokens
		acc.Output += b.OutputTokens
		acc.CacheRead += b.CacheReadTokens
		*cw += b.CacheWriteTokens
	}
	if ts.winCW > 0 || ts.usualCW > 0 {
		ts.win.CacheWrite, ts.usual.CacheWrite = &ts.winCW, &ts.usualCW
	}
	return ts
}

// spendToolRows is the tool calls of the agents that have a source (toolSources): in the window and the usual, per session in the window, and per hour ("2006-01-02T15").
type spendToolRows struct {
	window, usual int
	bySession     map[string]int
	byHour        map[string]int
}

// readToolCalls reads the tool_use events of the board's agents that have a tool source, hour by hour from the start of the usual period.
func (h *SpendHandler) readToolCalls(ctx context.Context, ro *spendRoster, fr spendFrame) (*spendToolRows, string) {
	var sessions, piSessions []string
	for _, id := range ro.order {
		switch typ := ro.accs[id].sess.AgentType; {
		case typ == agenttypes.Pi:
			piSessions = append(piSessions, id)
		case toolSources[typ]:
			sessions = append(sessions, id)
		}
	}
	const bucketLen = 13 // hourly always: the day series is made from the hours
	var rows []store.ToolCallBucket
	if len(sessions) > 0 {
		var err error
		if rows, err = h.db.ToolCallBuckets(ctx, sessions, spendDBStamp(fr.usualStart), spendDBStamp(fr.end), bucketLen); err != nil {
			return nil, "could not read tool calls"
		}
	}
	// A Pi agent's calls, hour by hour, from its session file: the same buckets as the events' (#11105).
	if h.reader != nil {
		since, until := spendDBStamp(fr.usualStart)[:bucketLen], spendDBStamp(fr.end)[:bucketLen]
		for _, id := range piSessions {
			_, byHour := h.reader.PiToolStats(id, ro.accs[id].sess.WorkingDir)
			for hour, n := range byHour {
				if hour >= since && hour < until { // the window ends on an hour
					rows = append(rows, store.ToolCallBucket{SessionID: id, Bucket: hour, N: n})
				}
			}
		}
	}
	out := &spendToolRows{bySession: map[string]int{}, byHour: map[string]int{}}
	for _, row := range rows {
		bt := row.Bucket
		t, perr := time.Parse("2006-01-02T15", bt)
		if perr != nil {
			continue
		}
		out.byHour[bt] += row.N
		if t.Before(fr.start) { // the start is hour-aligned like the buckets
			out.usual += row.N
			continue
		}
		out.window += row.N
		out.bySession[row.SessionID] += row.N
	}
	return out, ""
}

// spendCommitRead is what main's history says about the window and the usual: the summary the reply carries and the commits of each period.
type spendCommitRead struct {
	info       spendCommits
	win, usual []landedcommits.Commit
}

// readCommits reads the repository the board's agents share (their most common git root), its default branch's history for the usual period and the window, and the merge queue's landed commits in the window.
// Why there is nothing to say comes back in the words of info.Reason, never as a zero.
func (h *SpendHandler) readCommits(ctx context.Context, project string, ro *spendRoster, fr spendFrame) *spendCommitRead {
	var dirs []string
	for _, id := range ro.order {
		dirs = append(dirs, ro.accs[id].sess.WorkingDir)
	}
	cm := &spendCommitRead{info: spendCommits{QueueLanded: map[string]int{}}}
	if root := landedcommits.CommonRoot(ctx, dirs); root == "" {
		cm.info.Reason = "no repository found for this board's agents"
	} else if branch := landedcommits.DefaultBranch(ctx, root); branch == "" {
		cm.info.Reason = "the repository has no main branch (origin/HEAD, main or master)"
		cm.info.Repo = filepath.Base(root)
	} else {
		all, capped, err := h.commits.Read(ctx, root, branch, fr.usualStart, fr.end)
		if err != nil {
			cm.info.Reason = "the repository's history could not be read"
		} else {
			cm.info.Available, cm.info.Repo, cm.info.Branch, cm.info.Capped = true, filepath.Base(root), branch, capped
			for _, c := range all {
				if t, perr := time.Parse(time.RFC3339, c.At); perr == nil && !t.Before(fr.start) {
					cm.win = append(cm.win, c)
				} else {
					cm.usual = append(cm.usual, c)
				}
			}
			wn, un := len(cm.win), len(cm.usual)
			cm.info.Window, cm.info.Usual = &wn, &un
		}
	}
	if landed, err := h.bs.LandedSince(ctx, project, spendStamp(fr.start), 0); err == nil {
		seen := map[string]bool{}
		for _, l := range landed {
			if !seen[l.SHA] {
				seen[l.SHA] = true
				cm.info.QueueLanded[l.LandedBy]++
			}
		}
	}
	return cm
}

// spendNameKey is how two spellings of a name are one: lower case, without the spaces around it.
func spendNameKey(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// attributeCommits finds each commit's agent by its author name: the agent's display name, its role on the board or its folder, whichever comes first; a commit that matches no agent is counted in
// info.Unattributed. It answers the window's commits per session and every commit (both periods) per hour.
func attributeCommits(info *spendCommits, cm *spendCommitRead, ro *spendRoster) (map[string]int, map[string]int) {
	byName := map[string]string{} // lower-case name -> session id
	for _, id := range ro.order {
		a := ro.accs[id]
		for _, n := range []string{displayOf(a.sess), ro.roleOf[naming.SessionName(a.sess.AgentType, id)], a.sess.AgentName} {
			if k := spendNameKey(n); k != "" {
				if _, ok := byName[k]; !ok {
					byName[k] = id
				}
			}
		}
	}
	commitsBy := map[string]int{}
	hourCommits := map[string]int{}
	for _, c := range cm.win {
		if id, ok := byName[spendNameKey(c.Author)]; ok {
			commitsBy[id]++
		} else {
			info.Unattributed++
		}
	}
	for _, c := range append(append([]landedcommits.Commit(nil), cm.win...), cm.usual...) {
		if t, err := time.Parse(time.RFC3339, c.At); err == nil {
			hourCommits[t.Format("2006-01-02T15")]++
		}
	}
	return commitsBy, hourCommits
}

// spendTaskRead is the board's completed tasks in the window and in the usual period, the window's by completer (spendNameKey) and every one by hour ("2006-01-02T15").
type spendTaskRead struct {
	win, usual []board.TaskTime
	byAgent    map[string][]board.TaskTime
	byHour     map[string]int
}

func (h *SpendHandler) readTaskTimes(ctx context.Context, project string, fr spendFrame) (*spendTaskRead, string) {
	win, err := h.bs.TasksCompletedBetween(ctx, project, spendStamp(fr.start), spendStamp(fr.end))
	usual, err2 := h.bs.TasksCompletedBetween(ctx, project, spendStamp(fr.usualStart), spendStamp(fr.start))
	if err != nil || err2 != nil {
		return nil, "could not read task times"
	}
	tr := &spendTaskRead{win: win, usual: usual, byAgent: map[string][]board.TaskTime{}, byHour: map[string]int{}}
	for _, tt := range win {
		k := spendNameKey(tt.CompletedBy)
		tr.byAgent[k] = append(tr.byAgent[k], tt)
	}
	for _, tt := range append(append([]board.TaskTime(nil), win...), usual...) {
		if t, perr := time.Parse(time.RFC3339, tt.CompletedAt); perr == nil {
			tr.byHour[t.Format("2006-01-02T15")]++
		}
	}
	return tr, ""
}

// agentRows is one row per agent of the board, most tokens first: its names, what its CLI measures (tokens and their share of the measured agents', tool calls), its commits and the tasks it completed
// (found by display name, role or folder); a measure its CLI has no source for is nil, never zero. Commits no agent owns are one more row, "Unattributed". It answers the rows, how many agents have a
// token source and how many a tool-call source. tasksByAgent is consumed: a name's tasks are counted once.
func agentRows(ro *spendRoster, tools *spendToolRows, commitsBy map[string]int, tasksByAgent map[string][]board.TaskTime, unattributed int) ([]spendAgent, int, int) {
	total := int64(0)
	for _, id := range ro.order {
		if a := ro.accs[id]; a.sum != nil && tokenSources[a.sess.AgentType] {
			total += a.sum.InputTokens + a.sum.OutputTokens
		}
	}
	var rows []spendAgent
	tokenMeasured, toolMeasured := 0, 0
	for _, id := range ro.order {
		a := ro.accs[id]
		term := naming.SessionName(a.sess.AgentType, id)
		row := spendAgent{Name: displayOf(a.sess), AgentType: a.sess.AgentType, SessionID: id, Role: ro.roleOf[term], Orchestrator: ro.orchOf[term]}
		if row.Name == "" {
			row.Name = row.Role
		}
		if row.Name == "" {
			row.Name = "Agent"
		}
		if tokenSources[a.sess.AgentType] {
			row.Measured = true
			tokenMeasured++
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
			n := tools.bySession[id]
			row.ToolCalls = &n
		}
		row.Commits = commitsBy[id]
		var mine []board.TaskTime
		for _, k := range []string{spendNameKey(row.Name), spendNameKey(row.Role), spendNameKey(a.sess.AgentName)} {
			if k != "" {
				mine = append(mine, tasksByAgent[k]...)
				delete(tasksByAgent, k)
			}
		}
		st := board.SummarizeTaskTimes(mine)
		row.TasksDone, row.WorkMedianS = st.Done, st.WorkMedian
		rows = append(rows, row)
	}
	if unattributed > 0 {
		rows = append(rows, spendAgent{Name: "Unattributed", Commits: unattributed})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i].Tokens, rows[j].Tokens
		switch {
		case a != nil && b != nil:
			return *a > *b
		case a != nil:
			return true
		}
		return false
	})
	return rows, tokenMeasured, toolMeasured
}

// taskTimeBlock is the page's task times: the window's against the usual period's, and who completed how many in the window (the first spelling of a name names it; a task with no completer is in the
// totals and not listed), most first, then by name. The per-hour and per-day points are added with the series.
func taskTimeBlock(winTasks, usualTasks []board.TaskTime) spendTaskTime {
	tt := spendTaskTime{Window: board.SummarizeTaskTimes(winTasks), Usual: board.SummarizeTaskTimes(usualTasks), ReviewLabel: spendReviewLabel, Agents: []spendTaskAgent{}}
	byCompleter := map[string][]board.TaskTime{}
	displayOfKey := map[string]string{}
	for _, t := range winTasks {
		k := spendNameKey(t.CompletedBy)
		byCompleter[k] = append(byCompleter[k], t)
		if _, ok := displayOfKey[k]; !ok {
			displayOfKey[k] = strings.TrimSpace(t.CompletedBy)
		}
	}
	for k, tts := range byCompleter {
		if k == "" {
			continue
		}
		st := board.SummarizeTaskTimes(tts)
		tt.Agents = append(tt.Agents, spendTaskAgent{Name: displayOfKey[k], Done: st.Done, Median: st.WorkMedian, SentBack: st.WentBack2Plus})
	}
	sort.Slice(tt.Agents, func(i, j int) bool {
		a, b := tt.Agents[i], tt.Agents[j]
		if a.Done != b.Done {
			return a.Done > b.Done
		}
		return a.Name < b.Name
	})
	return tt
}

// addSeries adds the points of the charts, oldest first: an hour's point is its own hour; a day's is the sum of its 24 hours. The 24 h range has 24 hourly points and, as the week's bars, the six days before
// today and today (whole UTC days, today's still running); the 7 d range has its seven days. A measure nobody has a source for (cache write, commits, tool calls) is nil in every point.
func addSeries(resp *spendResponse, fr spendFrame, tok *spendTokenSeries, tools *spendToolRows, commitsByHour, tasksByHour map[string]int, toolMeasured int) {
	cwReported := tok.winCW > 0 || tok.usualCW > 0
	commitsAvailable := resp.Commits.Available
	pointOf := func(hours []time.Time) spendSeriesPoint {
		var p spendSeriesPoint
		var cw int64
		commits, toolCalls := 0, 0
		for _, t := range hours {
			key := t.Format("2006-01-02T15")
			p.Tokens += tok.hourTokens[key]
			p.CacheRead += tok.hourCache[key]
			cw += tok.hourCW[key]
			p.TasksDone += tasksByHour[key]
			commits += commitsByHour[key]
			toolCalls += tools.byHour[key]
		}
		if cwReported {
			p.CacheWrite = &cw
		}
		if commitsAvailable {
			p.Commits = &commits
		}
		if toolMeasured > 0 {
			p.ToolCalls = &toolCalls
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
	if fr.hourly {
		for t := fr.start; t.Before(fr.end); t = t.Add(time.Hour) {
			p := pointOf([]time.Time{t})
			p.Hour = t.Format(time.RFC3339)
			resp.PerHour = append(resp.PerHour, p)
			resp.TaskTime.PerHour = append(resp.TaskTime.PerHour, spendTaskPoint{Hour: p.Hour, Done: p.TasksDone})
		}
		today := time.Date(fr.now.Year(), fr.now.Month(), fr.now.Day(), 0, 0, 0, 0, time.UTC)
		dayPoints(today.Add(-6*24*time.Hour), today.Add(24*time.Hour))
	} else {
		dayPoints(fr.start, fr.end)
	}
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
	ctx := r.Context()

	roster, fail := h.readRoster(ctx, project, fr)
	if fail != "" {
		errInternalServer(w, fail)
		return
	}
	tok, fail := h.readTokenSeries(ctx, project, fr)
	if fail != "" {
		errInternalServer(w, fail)
		return
	}

	tools, fail := h.readToolCalls(ctx, roster, fr)
	if fail != "" {
		errInternalServer(w, fail)
		return
	}

	cm := h.readCommits(ctx, project, roster, fr)
	commitInfo := cm.info
	commitsBy, hourCommits := attributeCommits(&commitInfo, cm, roster)

	tasks, fail := h.readTaskTimes(ctx, project, fr)
	if fail != "" {
		errInternalServer(w, fail)
		return
	}

	// the reply: the frame and the board's tokens and commits, the agents, the tool calls, the task times, the charts
	resp := spendResponse{Board: project, Range: rng, RangeHours: fr.hours, GeneratedAt: spendStamp(now), WindowStart: spendStamp(fr.start), WindowEnd: spendStamp(fr.end),
		Tokens: map[string]spendTokens{"window": tok.win, "usual": tok.usual}, Commits: commitInfo, OfAgents: len(roster.order)}
	var toolMeasured int
	resp.Agents, resp.MeasuredAgents, toolMeasured = agentRows(roster, tools, commitsBy, tasks.byAgent, commitInfo.Unattributed)
	tc := spendToolCalls{MeasuredAgents: toolMeasured, OfAgents: len(roster.order)}
	if toolMeasured > 0 {
		tc.Window, tc.Usual = &tools.window, &tools.usual
	}
	resp.ToolCalls = tc
	resp.TaskTime = taskTimeBlock(tasks.win, tasks.usual)

	addSeries(&resp, fr, tok, tools, hourCommits, tasks.byHour, toolMeasured)
	writeJSON(w, http.StatusOK, resp)
}

// displayOf is a live session's name for people: its display name, else its folder name.
func displayOf(s store.LiveSession) string {
	if s.DisplayName != nil && strings.TrimSpace(*s.DisplayName) != "" {
		return strings.TrimSpace(*s.DisplayName)
	}
	return s.AgentName
}
