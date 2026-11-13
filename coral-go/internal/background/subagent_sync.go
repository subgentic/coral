package background

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"time"

	"github.com/subgentic/coral/internal/proxy"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/subagent"
)

// syncSubagentSpend brings the subagents table up to date for one main agent.
//
// It finds the subagent transcripts beside the main agent's transcript, prices
// each one, and upserts its cumulative totals under sessionID. Every transcript
// is re-read in full and stored as totals, so the operation is idempotent: it
// is safe to run on every poll and after a restart.
//
// changed reports whether a subagent's files need re-reading; pass nil to
// always re-read. One unreadable subagent does not stop the others: the first
// error is returned after all have been attempted. It returns how many
// subagents were written.
func syncSubagentSpend(ctx context.Context, st *store.SubagentStore, sessionID, parentTranscriptPath string, changed func(subagent.Files) bool, usage *subagentUsage) (int, error) {
	files, err := subagent.Discover(parentTranscriptPath)
	if err != nil {
		return 0, fmt.Errorf("discover subagents: %w", err)
	}

	synced := 0
	var firstErr error
	for _, f := range files {
		if changed != nil && !changed(f) {
			continue
		}
		if err := syncOneSubagent(ctx, st, sessionID, f, usage); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("subagent %s: %w", f.SubagentID, err)
			}
			continue
		}
		synced++
	}
	return synced, firstErr
}

func syncOneSubagent(ctx context.Context, st *store.SubagentStore, sessionID string, f subagent.Files, usage *subagentUsage) error {
	// Discover only returns plain ids; a Files from anywhere else with no usable one is not stored.
	if !subagent.ValidID(f.SubagentID) {
		return fmt.Errorf("subagent has no plain id")
	}
	t, err := subagent.ParseTranscript(f.TranscriptPath)
	if err != nil {
		return err
	}
	// Metadata is a nice-to-have; spend is recorded without it.
	meta, _ := subagent.ReadMeta(f.MetaPath)

	totals := t.Totals()
	if err := usage.record(ctx, sessionID, t); err != nil {
		return fmt.Errorf("record usage: %w", err)
	}
	return st.UpsertSubagent(ctx, &store.Subagent{
		// The row belongs to the main agent whose transcript directory the file
		// was found under, which is what sessionID identifies.
		SessionID:        sessionID,
		SubagentID:       f.SubagentID,
		SubagentType:     ptr.NonEmpty(meta.AgentType),
		Description:      ptr.NonEmpty(meta.Description),
		ToolUseID:        ptr.NonEmpty(meta.ToolUseID),
		Model:            ptr.NonEmpty(t.PrimaryModel()),
		SpawnDepth:       meta.SpawnDepth,
		APICalls:         totals.APICalls,
		InputTokens:      totals.InputTokens,
		OutputTokens:     totals.OutputTokens,
		CacheReadTokens:  totals.CacheReadTokens,
		CacheWriteTokens: totals.CacheWriteTokens,
		CostUSD:          subagentCostUSD(t),
		Finished:         t.Finished,
		TranscriptPath:   ptr.NonEmpty(f.TranscriptPath),
		StartedAt:        ptr.NonEmpty(t.StartedAt),
		LastActivityAt:   ptr.NonEmpty(t.LastActivityAt),
	})
}

// subagentCostUSD prices each call with its own model, since a subagent is
// not guaranteed to use one model throughout. Calls whose model has no known
// pricing contribute nothing rather than a guess.
func subagentCostUSD(t *subagent.Transcript) float64 {
	var total float64
	for _, c := range t.Calls {
		total += proxy.CalculateCost(c.Model, proxy.TokenUsage{
			InputTokens:      c.InputTokens,
			OutputTokens:     c.OutputTokens,
			CacheReadTokens:  c.CacheReadTokens,
			CacheWriteTokens: c.CacheWriteTokens,
		})
	}
	return total
}

// latestMtime returns the newest modification time among paths that exist.
func latestMtime(paths ...string) time.Time {
	var latest time.Time
	for _, p := range paths {
		if info, err := os.Stat(p); err == nil && info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}
	return latest
}

// subagentUsage puts a subagent's calls into the usage records of the agent that launched it (#16016): the agent's cost, its team's and
// Analytics are sums over those records, and a subagent's calls are not in the parent's transcript (Claude Code writes them to the
// subagent's own file), so without this they were in no cost at all. nil records nothing (the tests of the sync itself).
type subagentUsage struct {
	store     *store.TokenUsageStore
	agentName string
	agentType string
	teamID    *int64
	boardName *string
}

// usageRowTime is the instant a call's row is keyed on: the call's own timestamp plus 1 to 999 microseconds taken from its message id.
// The usage table keeps one row per (session, instant) and ignores a second, so the same call read again is the same row (the sync
// re-reads whole transcripts), and two subagents' calls in the same millisecond, or one at the instant of a turn of the parent, do not
// drop each other.
func usageRowTime(c subagent.Call) string {
	at, err := time.Parse(time.RFC3339Nano, c.Timestamp)
	if err != nil {
		return c.Timestamp
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(c.MessageID))
	return at.UTC().Add(time.Duration(1+h.Sum32()%999) * time.Microsecond).Format(store.ISOFormat)
}

// record writes the calls of t that are complete. A subagent still working may be part-way through its newest call (the timestamp that keys
// the row is the last record of that call, and it moves), so that one waits for the next call or for the subagent to finish; a call is then
// recorded once, with its final numbers.
func (u *subagentUsage) record(ctx context.Context, sessionID string, t *subagent.Transcript) error {
	if u == nil || u.store == nil {
		return nil
	}
	calls := t.Calls
	if !t.Finished && len(calls) > 0 {
		calls = calls[:len(calls)-1]
	}
	var recs []*store.TokenUsage
	for _, c := range calls {
		if c.InputTokens == 0 && c.OutputTokens == 0 {
			continue
		}
		at := usageRowTime(c)
		model := c.Model
		if model == "" {
			model = "claude-sonnet-4-20250514"
		}
		recs = append(recs, &store.TokenUsage{
			SessionID: sessionID, AgentName: u.agentName, AgentType: u.agentType, TeamID: u.teamID, BoardName: u.boardName,
			InputTokens: c.InputTokens, OutputTokens: c.OutputTokens, CacheReadTokens: c.CacheReadTokens, CacheWriteTokens: c.CacheWriteTokens,
			TotalTokens: c.InputTokens + c.OutputTokens + c.CacheReadTokens + c.CacheWriteTokens,
			CostUSD:     estimateCost(model, c.InputTokens, c.OutputTokens, c.CacheReadTokens, c.CacheWriteTokens),
			SessionStartAt: t.StartedAt, LastActivityAt: c.Timestamp, RecordedAt: at, Source: "jsonl", Model: c.Model,
		})
	}
	var first error
	for _, err := range u.store.RecordUsageBatch(ctx, recs) {
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}
