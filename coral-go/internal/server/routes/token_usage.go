package routes

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/store"
)

// TokenUsageHandler provides HTTP handlers for token usage API.
type TokenUsageHandler struct {
	ts *store.TokenUsageStore
}

// NewTokenUsageHandler creates a new TokenUsageHandler.
func NewTokenUsageHandler(db *store.DB) *TokenUsageHandler {
	return &TokenUsageHandler{
		ts: store.NewTokenUsageStore(db),
	}
}

// ListUsage returns filtered token usage records.
// GET /api/token-usage
func (h *TokenUsageHandler) ListUsage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	var filter store.UsageFilter
	filter.SessionID = q.Get("session_id")
	filter.BoardName = q.Get("board_name")
	filter.Since = q.Get("since")

	if teamIDStr := q.Get("team_id"); teamIDStr != "" {
		id, err := strconv.ParseInt(teamIDStr, 10, 64)
		if err != nil {
			errBadRequest(w, "invalid team_id")
			return
		}
		filter.TeamID = &id
	}

	records, err := h.ts.ListUsage(r.Context(), filter)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	// Compute aggregated totals
	var totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalTokens int64
	var totalCost float64
	var firstMessage, lastMessage time.Time
	for _, r := range records {
		totalInput += int64(r.InputTokens)
		totalOutput += int64(r.OutputTokens)
		totalCacheRead += int64(r.CacheReadTokens)
		totalCacheWrite += int64(r.CacheWriteTokens)
		totalTokens += int64(r.TotalTokens)
		totalCost += r.CostUSD
		if ts, err := time.Parse(time.RFC3339Nano, r.SessionStartAt); err == nil && (firstMessage.IsZero() || ts.Before(firstMessage)) {
			firstMessage = ts
		}
		if ts, err := time.Parse(time.RFC3339Nano, r.LastActivityAt); err == nil && (lastMessage.IsZero() || ts.After(lastMessage)) {
			lastMessage = ts
		}
	}
	var executionTimeSec int64
	if !firstMessage.IsZero() && !lastMessage.IsZero() && lastMessage.After(firstMessage) {
		executionTimeSec = int64(lastMessage.Sub(firstMessage).Seconds())
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"records": records,
		"totals": map[string]any{
			"input_tokens":       totalInput,
			"output_tokens":      totalOutput,
			"cache_read_tokens":  totalCacheRead,
			"cache_write_tokens": totalCacheWrite,
			"total_tokens":       totalTokens,
			"cost_usd":           totalCost,
			"num_sessions":       len(records),
			"first_message_at":   formatOptionalTime(firstMessage),
			"last_message_at":    formatOptionalTime(lastMessage),
			"execution_time_sec": executionTimeSec,
		},
	})
}

func formatOptionalTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// maxUsageByAgentLimit bounds by_agent_limit: more sessions than a machine has ever had (#9820).
const maxUsageByAgentLimit = 100000

// UsageSummary returns high-level aggregated usage.
// GET /api/token-usage/summary
//
// by_agent is one row per session (about 0.9 MiB for 3,000 sessions, #9820). include=totals leaves it out (and its query is not run); by_agent_limit=N keeps the N sessions with the most tokens
// and adds by_agent_total, how many there were. Neither given, the answer is what it always was (the sessions by cost); the totals are always of every session.
func (h *TokenUsageHandler) UsageSummary(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	since := q.Get("since")
	if inc := q.Get("include"); inc != "" && inc != "totals" {
		errBadRequest(w, "include is totals, or leave it out")
		return
	}
	totalsOnly := q.Get("include") == "totals"
	agentLimit, ok := parseBoundedInt(q.Get("by_agent_limit"), 0, 1, maxUsageByAgentLimit)
	if !ok {
		errBadRequest(w, fmt.Sprintf("by_agent_limit must be an integer between 1 and %d", maxUsageByAgentLimit))
		return
	}

	summaries, err := h.ts.GetUsageSummary(r.Context(), since)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	var byAgent []store.AgentUsageSummary
	if !totalsOnly {
		if byAgent, err = h.ts.GetUsageSummaryByAgent(r.Context(), since); err != nil {
			errInternalServer(w, err.Error())
			return
		}
	}
	byAgentTotal := len(byAgent)
	if agentLimit > 0 && len(byAgent) > 0 {
		sort.SliceStable(byAgent, func(i, j int) bool { return byAgent[i].TotalTokens > byAgent[j].TotalTokens }) // the most tokens first; ties keep the cost order
		if len(byAgent) > agentLimit {
			byAgent = byAgent[:agentLimit]
		}
	}

	byModel, err := h.ts.GetUsageSummaryByModel(r.Context(), since)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	tracked, err := h.ts.GetUsageByThinking(r.Context(), since)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	byThinking := withNotReported(tracked, byModel)

	// Compute grand totals
	var totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalTokens int64
	var totalCost float64
	var totalSessions int
	var totalRequests int64
	for _, s := range summaries {
		totalInput += s.InputTokens
		totalOutput += s.OutputTokens
		totalCacheRead += s.CacheReadTokens
		totalCacheWrite += s.CacheWriteTokens
		totalTokens += s.TotalTokens
		totalCost += s.CostUSD
		totalSessions += s.NumSessions
		totalRequests += s.NumRequests
	}

	out := map[string]any{
		"by_agent_type": summaries,
		"by_model":      byModel,
		"by_thinking":   byThinking,
		"totals": map[string]any{
			"input_tokens":       totalInput,
			"output_tokens":      totalOutput,
			"cache_read_tokens":  totalCacheRead,
			"cache_write_tokens": totalCacheWrite,
			"total_tokens":       totalTokens,
			"cost_usd":           totalCost,
			"num_sessions":       totalSessions,
			"num_requests":       totalRequests,
		},
	}
	// by_agent is one row per session of every board (id, name, board, working directory): an agent's token gets the totals, not that list (#5041).
	if _, isAgent := VerifiedSession(r.Context()); !isAgent && !totalsOnly {
		out["by_agent"] = byAgent
		if agentLimit > 0 {
			out["by_agent_total"] = byAgentTotal
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// SessionTurns returns per-turn cost data for a session.
// GET /api/token-usage/session/{sessionID}/turns
func (h *TokenUsageHandler) SessionTurns(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		errBadRequest(w, "session_id required")
		return
	}

	turns, err := h.ts.GetSessionTurns(r.Context(), sessionID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	// Compute cumulative cost
	type turnWithCumulative struct {
		Turn             int     `json:"turn"`
		CostUSD          float64 `json:"cost_usd"`
		CumulativeCost   float64 `json:"cumulative_cost"`
		InputTokens      int64   `json:"input_tokens"`
		OutputTokens     int64   `json:"output_tokens"`
		CacheReadTokens  int64   `json:"cache_read_tokens"`
		CacheWriteTokens int64   `json:"cache_write_tokens"`
		Model            string  `json:"model"`
		Timestamp        string  `json:"timestamp"`
	}

	result := make([]turnWithCumulative, len(turns))
	var cumulative float64
	for i, t := range turns {
		cumulative += t.CostUSD
		result[i] = turnWithCumulative{
			Turn:             i + 1,
			CostUSD:          t.CostUSD,
			CumulativeCost:   cumulative,
			InputTokens:      t.InputTokens,
			OutputTokens:     t.OutputTokens,
			CacheReadTokens:  t.CacheReadTokens,
			CacheWriteTokens: t.CacheWriteTokens,
			Model:            t.Model,
			Timestamp:        t.RecordedAt,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"turns": result})
}

// UsageTurns lists the turns that made up a window of usage.
// GET /api/token-usage/turns?agent=...&session_id=...&since=...&until=...&order=cost|time&limit=N
// It names agents, so an agent's token is not given it (as it is not given by_agent). until is exclusive, an RFC 3339 time.
func (h *TokenUsageHandler) UsageTurns(w http.ResponseWriter, r *http.Request) {
	if _, isAgent := VerifiedSession(r.Context()); isAgent {
		errForbidden(w, "an agent's token cannot read the turns of every agent")
		return
	}
	q := r.URL.Query()
	until := q.Get("until")
	if until != "" {
		t, err := time.Parse(time.RFC3339Nano, until)
		if err != nil {
			errBadRequest(w, "until must be an RFC 3339 time")
			return
		}
		until = t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	order := q.Get("order")
	if order != "" && order != "cost" && order != "time" {
		errBadRequest(w, "order must be cost or time")
		return
	}
	limit := 0
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			errBadRequest(w, "limit must be a positive number")
			return
		}
		limit = n
	}
	turns, err := h.ts.GetUsageTurns(r.Context(), store.UsageTurnsQuery{Agent: q.Get("agent"), Session: q.Get("session_id"), Since: q.Get("since"), Until: until, Order: order, Limit: limit})
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if turns == nil {
		turns = []store.UsageTurn{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"turns": turns})
}

// timeseriesHourlySpan is the longest range that is read in hourly buckets when the caller names no interval (#9113): a week is 168 of them.
const timeseriesHourlySpan = 7 * 24 * time.Hour

// defaultTimeseriesInterval is the bucket size of a timeseries read that names none: hourly for a range of up to a week, daily for a longer one, so the reply is bounded by the
// range (365 buckets for a year, not 8,760). No since is all history, which is a long range. The range stays what the caller asked for: the line still ends at the summary's total.
// A since that is not a time keeps the old default (the read answers it as it always did).
func defaultTimeseriesInterval(since, until string, now time.Time) string {
	if since == "" {
		return "1d"
	}
	from, err := time.Parse(time.RFC3339Nano, since)
	if err != nil {
		return "1h"
	}
	to := now
	if until != "" {
		if t, err := time.Parse(time.RFC3339Nano, until); err == nil {
			to = t
		}
	}
	if to.Sub(from) > timeseriesHourlySpan {
		return "1d"
	}
	return "1h"
}

// UsageTimeSeries returns bucketed time-series cost data.
// GET /api/token-usage/timeseries?since=...&until=...&interval=5m|1h|1d&board=...&group_by=team|agent|provider|model
// interval defaults to 1h for a range of up to 7 days and to 1d for a longer one (no since is all history: 1d); an interval that is named is used as named.
// until is exclusive (an RFC 3339 time: the prior period is since=A&until=B beside since=B); group_by adds, to each bucket, the series that had usage in it (the bucket's own
// figures stay the sum of all of them). The agent's token is not given group_by=agent (it names the agents of every board, as by_agent does).
func (h *TokenUsageHandler) UsageTimeSeries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	since := q.Get("since")
	until := q.Get("until")
	if until != "" {
		t, err := time.Parse(time.RFC3339Nano, until)
		if err != nil {
			errBadRequest(w, "until must be an RFC 3339 time")
			return
		}
		until = t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	interval := q.Get("interval")
	if interval == "" {
		interval = defaultTimeseriesInterval(since, until, time.Now())
	}
	groupBy := q.Get("group_by")
	if !store.ValidUsageGroup(groupBy) {
		errBadRequest(w, "group_by must be team, agent, provider or model")
		return
	}
	if _, isAgent := VerifiedSession(r.Context()); isAgent && groupBy == "agent" {
		errForbidden(w, "an agent's token cannot read the usage of every agent")
		return
	}

	buckets, err := h.ts.GetUsageTimeSeriesGrouped(r.Context(), store.TimeSeriesQuery{Since: since, Until: until, Interval: interval, Board: q.Get("board"), GroupBy: groupBy})
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	// Compute cumulative cost
	type bucketWithCumulative struct {
		Bucket           string                   `json:"bucket"`
		CostUSD          float64                  `json:"cost_usd"`
		CumulativeCost   float64                  `json:"cumulative_cost"`
		InputTokens      int64                    `json:"input_tokens"`
		OutputTokens     int64                    `json:"output_tokens"`
		CacheReadTokens  int64                    `json:"cache_read_tokens"`
		CacheWriteTokens int64                    `json:"cache_write_tokens"`
		NumRequests      int                      `json:"num_requests"`
		Series           []store.TimeSeriesSeries `json:"series,omitempty"`
	}

	result := make([]bucketWithCumulative, len(buckets))
	var cumulative float64
	for i, b := range buckets {
		cumulative += b.CostUSD
		result[i] = bucketWithCumulative{
			Bucket:           b.Bucket,
			CostUSD:          b.CostUSD,
			CumulativeCost:   cumulative,
			InputTokens:      b.InputTokens,
			OutputTokens:     b.OutputTokens,
			CacheReadTokens:  b.CacheReadTokens,
			CacheWriteTokens: b.CacheWriteTokens,
			NumRequests:      b.NumRequests,
			Series:           b.Series,
		}
	}

	out := map[string]any{"buckets": result, "interval": interval}
	if groupBy != "" {
		out["group_by"] = groupBy
	}
	writeJSON(w, http.StatusOK, out)
}

// UsageSummaryByBranch returns per-branch usage breakdown.
// GET /api/token-usage/by-branch?since=...&branch=...
func (h *TokenUsageHandler) UsageSummaryByBranch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	since := q.Get("since")
	branch := q.Get("branch")

	branches, err := h.ts.GetUsageSummaryByBranch(r.Context(), since, branch)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	for i := range branches {
		branches[i].RepoName = gitutil.ParseRepoName(branches[i].RemoteURL)
	}

	var totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalTokens int64
	var totalCost float64
	var totalAgents int
	for _, b := range branches {
		totalInput += b.InputTokens
		totalOutput += b.OutputTokens
		totalCacheRead += b.CacheReadTokens
		totalCacheWrite += b.CacheWriteTokens
		totalTokens += b.TotalTokens
		totalCost += b.CostUSD
		totalAgents += b.NumAgents
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"branches": branches,
		"totals": map[string]any{
			"input_tokens":       totalInput,
			"output_tokens":      totalOutput,
			"cache_read_tokens":  totalCacheRead,
			"cache_write_tokens": totalCacheWrite,
			"total_tokens":       totalTokens,
			"cost_usd":           totalCost,
			"num_agents":         totalAgents,
		},
	})
}

// UsageSummaryByBoard returns per-board/team usage breakdown.
// GET /api/token-usage/by-team?since=...
func (h *TokenUsageHandler) UsageSummaryByBoard(w http.ResponseWriter, r *http.Request) {
	since := r.URL.Query().Get("since")

	teams, err := h.ts.GetUsageSummaryByBoard(r.Context(), since)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"teams": teams})
}

// withNotReported is the usage by thinking level: the levels the transcripts recorded (tracked) and, for each agent type and model, a ""
// row for the rest of that model's usage: calls whose turn recorded no level, and everything from before the levels were tracked (#4969). It is
// the model's total (byModel, the By Model table) less what is tracked for it, never filled with the level an agent was launched with. The breakdown
// is kept by hour, so a range that starts inside an hour can track a little more than the total counts: the rest is then none, never negative.
//
// Tracked rows with no model are what was kept before the model was in the key (#5120) and calls that named none; the first are part of the
// totals of models that were not kept with them, so counting them besides those models' remainders would count them twice. They are shown as they
// are and taken out of the type's remainders (the model-less remainder first, then the models' largest first), so that a type's rows still add
// up to its totals. Nothing is attributed to a model: the remainders are what is left.
func withNotReported(tracked []store.ThinkingUsageSummary, byModel []store.ModelUsageSummary) []store.ThinkingUsageSummary {
	out := append([]store.ThinkingUsageSummary{}, tracked...)
	type key struct{ agentType, model string }
	sum := map[key]*store.ThinkingUsageSummary{}
	legacy := map[string]*store.ThinkingUsageSummary{} // by agent type: the tracked rows with no model
	add := func(to *store.ThinkingUsageSummary, t store.ThinkingUsageSummary) {
		to.InputTokens += t.InputTokens
		to.OutputTokens += t.OutputTokens
		to.CacheReadTokens += t.CacheReadTokens
		to.CacheWriteTokens += t.CacheWriteTokens
		to.TotalTokens += t.TotalTokens
		to.CostUSD += t.CostUSD
		to.NumCalls += t.NumCalls
	}
	for _, t := range tracked {
		k := key{t.AgentType, t.Model}
		if sum[k] == nil {
			sum[k] = &store.ThinkingUsageSummary{AgentType: t.AgentType, Model: t.Model}
		}
		add(sum[k], t)
		if t.Model == "" {
			if legacy[t.AgentType] == nil {
				legacy[t.AgentType] = &store.ThinkingUsageSummary{AgentType: t.AgentType}
			}
			add(legacy[t.AgentType], t)
		}
	}
	clamp := func(a, b int64) int64 {
		if a < b {
			return 0
		}
		return a - b
	}
	// The remainders, by agent type.
	rests := map[string][]*store.ThinkingUsageSummary{}
	var types []string
	for _, tot := range byModel {
		have := sum[key{tot.AgentType, tot.Model}]
		if tot.Model == "" {
			have = nil // the model-less tracked rows come out of the pool below, not out of this model's own total
		}
		if have == nil {
			have = &store.ThinkingUsageSummary{}
		}
		rest := &store.ThinkingUsageSummary{AgentType: tot.AgentType, Model: tot.Model,
			InputTokens: clamp(tot.InputTokens, have.InputTokens), OutputTokens: clamp(tot.OutputTokens, have.OutputTokens),
			CacheReadTokens: clamp(tot.CacheReadTokens, have.CacheReadTokens), CacheWriteTokens: clamp(tot.CacheWriteTokens, have.CacheWriteTokens),
			TotalTokens: clamp(tot.TotalTokens, have.TotalTokens), NumCalls: clamp(tot.NumRequests, have.NumCalls)}
		if tot.CostUSD > have.CostUSD {
			rest.CostUSD = tot.CostUSD - have.CostUSD
		}
		if len(rests[tot.AgentType]) == 0 {
			types = append(types, tot.AgentType)
		}
		rests[tot.AgentType] = append(rests[tot.AgentType], rest)
	}
	for _, typ := range types {
		pool := rests[typ]
		if l := legacy[typ]; l != nil {
			// Model-less remainder first, then the largest remainders.
			sort.SliceStable(pool, func(i, j int) bool {
				if (pool[i].Model == "") != (pool[j].Model == "") {
					return pool[i].Model == ""
				}
				return pool[i].CostUSD > pool[j].CostUSD
			})
			left := *l
			for _, r := range pool {
				take := func(have *int64, want *int64) {
					n := min(*have, *want)
					*have -= n
					*want -= n
				}
				take(&r.InputTokens, &left.InputTokens)
				take(&r.OutputTokens, &left.OutputTokens)
				take(&r.CacheReadTokens, &left.CacheReadTokens)
				take(&r.CacheWriteTokens, &left.CacheWriteTokens)
				take(&r.TotalTokens, &left.TotalTokens)
				take(&r.NumCalls, &left.NumCalls)
				if n := min(r.CostUSD, left.CostUSD); n > 0 {
					r.CostUSD -= n
					left.CostUSD -= n
				}
			}
		}
		for _, r := range rests[typ] {
			if r.TotalTokens > 0 || r.CostUSD > 0 {
				out = append(out, *r)
			}
		}
	}
	return out
}
