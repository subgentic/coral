package jsonl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #21057 (feature bets stage 2, task 9): the waste line per agent. From a Claude transcript: a cache expiry is a model call that came more than the cache's five minutes after the one before it and wrote its
// prompt again (cache writes beat cache reads); an idle compaction is a /compact typed at the prompt (compact_boundary, trigger manual), not the CLI's own mid-turn one (auto).
func wasteOf(t *testing.T, sid string, lines []string, from, to time.Time) (Waste, bool) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	return NewSessionReader().Waste(sid, "", at.Claude, from, to)
}

func wasteTurn(id, ts string, read, create int, extra string) string {
	return fmt.Sprintf(`{"type":"assistant","timestamp":%q,%s"message":{"id":%q,"content":[{"type":"text","text":"x"}],"usage":{"input_tokens":3,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d}}}`, ts, extra, id, read, create)
}

func compaction(ts, trigger string) string {
	return fmt.Sprintf(`{"type":"system","subtype":"compact_boundary","timestamp":%q,"compactMetadata":{"trigger":%q,"preTokens":170000,"postTokens":20000}}`, ts, trigger)
}

var (
	wasteFrom = time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	wasteTo   = time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
)

func TestWaste_ACallAfterTheCacheTimeThatWroteItsPromptAgainIsAnExpiry(t *testing.T) {
	w, ok := wasteOf(t, "21057000-0000-4000-8000-000000000001", []string{
		wasteTurn("m1", "2026-11-10T04:00:00.000Z", 1000, 10, ""),
		wasteTurn("m2", "2026-11-10T04:01:00.000Z", 1010, 5, ""),  // a minute later, read: no
		wasteTurn("m3", "2026-11-10T04:10:00.000Z", 0, 5000, ""),  // nine minutes later, wrote it all again: an expiry
		wasteTurn("m4", "2026-11-10T04:11:00.000Z", 5000, 20, ""), // read again: no
		wasteTurn("m5", "2026-11-10T04:30:00.000Z", 5020, 40, ""), // twenty minutes later but the cache held (an hour cache): no
	}, wasteFrom, wasteTo)
	require.True(t, ok)
	assert.Equal(t, 1, w.CacheExpiries)
	assert.Equal(t, 0, w.IdleCompactions)
}

func TestWaste_AMessageWrittenAsSeveralEntriesIsOneCall(t *testing.T) {
	w, _ := wasteOf(t, "21057000-0000-4000-8000-000000000002", []string{
		wasteTurn("m1", "2026-11-10T04:00:00.000Z", 1000, 10, ""),
		wasteTurn("m2", "2026-11-10T04:10:00.000Z", 0, 5000, ""),
		wasteTurn("m2", "2026-11-10T04:10:01.000Z", 0, 5000, ""), // the same call's next block, the same usage
	}, wasteFrom, wasteTo)
	assert.Equal(t, 1, w.CacheExpiries)
}

func TestWaste_ASubagentsCallsAreNotTheAgents(t *testing.T) {
	w, _ := wasteOf(t, "21057000-0000-4000-8000-000000000003", []string{
		wasteTurn("m1", "2026-11-10T04:00:00.000Z", 1000, 10, ""),
		wasteTurn("s1", "2026-11-10T04:10:00.000Z", 0, 9000, `"isSidechain":true,`),
		wasteTurn("m2", "2026-11-10T04:10:30.000Z", 1010, 5, ""),
	}, wasteFrom, wasteTo)
	assert.Equal(t, 0, w.CacheExpiries, "the subagent has its own cache")
}

func TestWaste_OnlyAManualCompactionIsAnIdleOne(t *testing.T) {
	w, _ := wasteOf(t, "21057000-0000-4000-8000-000000000004", []string{
		wasteTurn("m1", "2026-11-10T04:00:00.000Z", 1000, 10, ""),
		compaction("2026-11-10T04:05:00.000Z", "manual"),
		compaction("2026-11-10T05:05:00.000Z", "auto"),
	}, wasteFrom, wasteTo)
	assert.Equal(t, 1, w.IdleCompactions, "a /compact typed at the prompt; the CLI's own auto one comes mid-turn")
}

func TestWaste_OnlyTheRangeCounts(t *testing.T) {
	w, _ := wasteOf(t, "21057000-0000-4000-8000-000000000005", []string{
		wasteTurn("m1", "2026-11-09T04:00:00.000Z", 1000, 10, ""),
		wasteTurn("m2", "2026-11-09T04:10:00.000Z", 0, 5000, ""), // before the range
		compaction("2026-11-09T04:20:00.000Z", "manual"),
		wasteTurn("m3", "2026-11-10T04:00:00.000Z", 5000, 10, ""),
		wasteTurn("m4", "2026-11-10T04:10:00.000Z", 0, 5000, ""), // in it
		compaction("2026-11-10T04:20:00.000Z", "manual"),
		wasteTurn("m5", "2026-11-11T04:10:00.000Z", 0, 5000, ""), // after it
	}, wasteFrom, wasteTo)
	assert.Equal(t, 1, w.CacheExpiries)
	assert.Equal(t, 1, w.IdleCompactions)
}

func TestWaste_OnlyAClaudeTranscriptHasThese(t *testing.T) {
	_, ok := NewSessionReader().Waste("21057000-0000-4000-8000-000000000006", "", at.Codex, wasteFrom, wasteTo)
	assert.False(t, ok)
	_, ok = NewSessionReader().Waste("no-such-session", "", at.Claude, wasteFrom, wasteTo)
	assert.False(t, ok, "no transcript, no figures: not zeros")
}
