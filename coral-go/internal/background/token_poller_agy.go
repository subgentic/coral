package background

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/store"
)

// agy (Antigravity CLI) writes the tokens of each model call on its PLANNER_RESPONSE rows: input_tokens, cache_read_tokens and output_tokens (#7764). The transcript is found by the
// conversation agy's own hook named for the session (jsonl.ResolveAgyTranscript), never by the newest file.

type agyCallData struct {
	InputTokens     int
	OutputTokens    int
	CacheReadTokens int
	Timestamp       string
}

type agyUsageData struct {
	Calls          []agyCallData
	SessionStartAt string
}

// agyParser extracts per-call usage from an agy transcript's lines.
type agyParser struct {
	agyUsageData
}

func (p *agyParser) line(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	var entry struct {
		Type            string `json:"type"`
		CreatedAt       string `json:"created_at"`
		InputTokens     int    `json:"input_tokens"`
		OutputTokens    int    `json:"output_tokens"`
		CacheReadTokens int    `json:"cache_read_tokens"`
	}
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		return
	}
	if entry.CreatedAt != "" && p.SessionStartAt == "" {
		p.SessionStartAt = entry.CreatedAt
	}
	if entry.Type == "PLANNER_RESPONSE" && (entry.InputTokens > 0 || entry.OutputTokens > 0 || entry.CacheReadTokens > 0) {
		p.Calls = append(p.Calls, agyCallData{InputTokens: entry.InputTokens, OutputTokens: entry.OutputTokens, CacheReadTokens: entry.CacheReadTokens, Timestamp: entry.CreatedAt})
	}
}

func (p *agyParser) takeCalls() []agyCallData {
	c := p.Calls
	p.Calls = nil
	return c
}

func (p *TokenPoller) pollAgySession(ctx context.Context, ls *store.LiveSession) {
	path, ok := p.sessionPaths[ls.SessionID]
	if !ok {
		path = jsonl.ResolveAgyTranscript(ls.SessionID, ls.WorkingDir)
		if path == "" {
			return
		}
		p.logger.Info("matched transcript for agy session", "session_id", ls.SessionID[:8], "path", filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path)))))
		p.sessionPaths[ls.SessionID] = path
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if lastMtime, ok := p.lastMtime[path]; ok && !info.ModTime().After(lastMtime) && !cursorPending(p.agyCursors, ls.SessionID) {
		return
	}
	p.setMtime(ls.SessionID, path, info.ModTime())

	cur := cursorFor(p.agyCursors, ls.SessionID)
	appended, first := scanUsage(cur, path, (*agyParser).line, (*agyParser).takeCalls)
	total := cur.total
	if total == 0 || total <= p.lastEntryCount[ls.SessionID] {
		return
	}
	newCalls := unprocessed(appended, first, p.lastEntryCount[ls.SessionID])
	sessionStartAt := cur.parser.SessionStartAt
	agentName := ""
	if ls.DisplayName != nil {
		agentName = *ls.DisplayName
	}
	model := ""
	if ls.Model != nil {
		model = *ls.Model
	}

	var recs []*store.TokenUsage
	for _, call := range newCalls {
		recs = append(recs, &store.TokenUsage{
			SessionID:       ls.SessionID,
			AgentName:       agentName,
			AgentType:       at.Agy,
			TeamID:          ls.TeamID,
			BoardName:       ls.BoardName,
			InputTokens:     call.InputTokens,
			OutputTokens:    call.OutputTokens,
			CacheReadTokens: call.CacheReadTokens,
			TotalTokens:     call.InputTokens + call.OutputTokens + call.CacheReadTokens,
			CostUSD:         estimateCost(model, call.InputTokens, call.OutputTokens, call.CacheReadTokens, 0),
			SessionStartAt:  sessionStartAt,
			LastActivityAt:  call.Timestamp,
			RecordedAt:      call.Timestamp,
			Source:          "jsonl",
			Model:           model,
		})
	}
	for i, err := range p.usageStore.RecordUsageBatch(ctx, recs) {
		if err != nil {
			p.logger.Error("failed to record agy usage", "session_id", ls.SessionID, "error", err)
			continue
		}
		p.logger.Debug("recorded agy call", "session_id", ls.SessionID[:8], "input", recs[i].InputTokens, "output", recs[i].OutputTokens, "timestamp", recs[i].RecordedAt)
	}
	p.lastEntryCount[ls.SessionID] = total
}
