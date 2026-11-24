package routes

import (
	"net/http"
	"sort"
	"strconv"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/jsonl"
)

// GET /api/analytics/waste?days=&team= (feature bets stage 2, task 9, #21057): the waste line per agent on the cost page, from data Coral already collects. NUMBERS AND NAMES ONLY (an agent's name and counts).
//   - re-read share: of the input an agent's calls paid for (new input + cache reads + cache writes), the share that was the earlier conversation read again (cache reads). From the usage rows, every vendor.
//   - cache expiries and idle compactions: from a Claude transcript (jsonl.Waste); null for another vendor's agent, never a zero that says "none".
//
// The Operator's alone and read only, on this computer: through Coral Hub it is never served (class b for agents, tier "never" via Hub), as the limit waits are. Rows are per agent name (one role over several
// sessions is one row); a team that no row names answers empty, never every team.

type wasteRow struct {
	Agent           string  `json:"agent"`
	InputTokens     int64   `json:"input_tokens"`  // new input + cache reads + cache writes
	RereadTokens    int64   `json:"reread_tokens"` // the cache reads
	RereadShare     float64 `json:"reread_share"`  // 0..1
	CacheExpiries   *int    `json:"cache_expiries"`
	IdleCompactions *int    `json:"idle_compactions"`
}

// Waste is GET /api/analytics/waste.
func (h *TokenUsageHandler) Waste(w http.ResponseWriter, r *http.Request) {
	if !operatorOnlyRead(w, r) {
		return
	}
	days := 7
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "days is a positive number")
			return
		}
		days = n
	}
	if days > 90 {
		days = 90
	}
	team := r.URL.Query().Get("team")
	if team != "" && !commentBoardRe.MatchString(team) {
		errBadRequest(w, "team must be a team name")
		return
	}
	now := time.Now()
	if h.now != nil {
		now = h.now()
	}
	since := now.AddDate(0, 0, -days)
	rows, err := h.ts.GetUsageSummaryByAgentBoard(r.Context(), since.UTC().Format("2006-01-02T15:04:05.000Z"), team)
	if err != nil {
		errInternalServer(w, "the read failed")
		return
	}
	by := map[string]*wasteRow{}
	var order []string
	reader := jsonl.NewSessionReader()
	for _, s := range rows {
		name := s.AgentName
		if name == "" {
			name = s.Folder
		}
		row := by[name]
		if row == nil {
			row = &wasteRow{Agent: name}
			by[name] = row
			order = append(order, name)
		}
		row.InputTokens += s.InputTokens + s.CacheReadTokens + s.CacheWriteTokens
		row.RereadTokens += s.CacheReadTokens
		if s.AgentType == at.Claude || s.AgentType == "" {
			if wf, ok := reader.Waste(s.SessionID, s.WorkingDir, at.Claude, since, now.Add(time.Minute)); ok {
				row.CacheExpiries = addCount(row.CacheExpiries, wf.CacheExpiries)
				row.IdleCompactions = addCount(row.IdleCompactions, wf.IdleCompactions)
			}
		}
	}
	out := make([]wasteRow, 0, len(order))
	var tot wasteRow
	var totExp, totComp int
	var anyExp bool
	for _, name := range order {
		row := by[name]
		if row.InputTokens > 0 {
			row.RereadShare = float64(row.RereadTokens) / float64(row.InputTokens)
		}
		tot.InputTokens += row.InputTokens
		tot.RereadTokens += row.RereadTokens
		if row.CacheExpiries != nil {
			totExp += *row.CacheExpiries
			anyExp = true
		}
		if row.IdleCompactions != nil {
			totComp += *row.IdleCompactions
		}
		out = append(out, *row)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].RereadTokens > out[j].RereadTokens })
	totals := map[string]any{"input_tokens": tot.InputTokens, "reread_tokens": tot.RereadTokens, "reread_share": 0.0, "cache_expiries": nil, "idle_compactions": nil}
	if tot.InputTokens > 0 {
		totals["reread_share"] = float64(tot.RereadTokens) / float64(tot.InputTokens)
	}
	if anyExp {
		totals["cache_expiries"], totals["idle_compactions"] = totExp, totComp
	}
	writeJSON(w, http.StatusOK, map[string]any{"days_asked": days, "team": team, "generated_at": now.UTC().Format(time.RFC3339), "totals": totals, "rows": out})
}

func addCount(p *int, n int) *int {
	if p == nil {
		return &n
	}
	*p += n
	return p
}
