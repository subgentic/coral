package background

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/jsonl"
)

// limitPosts are the board posts that announce a usage limit.
func (h *checkHarness) limitPosts() []string {
	h.t.Helper()
	msgs, err := h.s.ListMessages(context.Background(), "team", 500, 0, 0)
	require.NoError(h.t, err)
	var out []string
	for _, m := range msgs {
		if strings.Contains(m.Content, "usage limit") {
			out = append(out, m.Content)
		}
	}
	return out
}

// Brief task 1 (#21018): a limit hit is one post to the Orchestrator with the agent, its open task, the vendor and the reset time; the many scans and retries
// while the agent stays blocked add nothing, and a new hit after the limit lifted is a new post.
func TestALimitHitIsOnePostToTheOrchestrator(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 40*time.Minute)
	task, err := h.s.CreateTask(ctx, "team", "Change the Go code", "", "high", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	devSID := h.sid(2)
	blocked := true
	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) {
		return 2*time.Hour + 5*time.Minute, blocked && a.SessionID == devSID
	}

	for i := 0; i < 5; i++ { // the screen is read again at every scan: a retry, a nudge, the roster
		h.now = h.now.Add(11 * time.Minute)
		h.m.scan(ctx)
	}
	posts := h.limitPosts()
	require.Len(t, posts, 1, "one post for the hit, not one per scan: %q", posts)
	p := posts[0]
	assert.Contains(t, p, "@Orchestrator")
	assert.Contains(t, p, "Dev")
	assert.Contains(t, p, "#"+fmt.Sprint(task.ID), "the open task")
	assert.Contains(t, p, "claude", "the vendor")
	assert.Contains(t, p, "2 h 5 min", "the reset time")

	// The limit lifts, and a later hit is a new post.
	blocked = false
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(ctx)
	h.now = h.now.Add(limitHitClearAfter + time.Minute)
	h.m.scan(ctx)
	blocked = true
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(ctx)
	assert.Len(t, h.limitPosts(), 2)
}

// With no Orchestrator the notice is a question to the Operator (Needs you).
func TestALimitHitWithNoOrchestratorGoesToNeedsYou(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Dev", "Developer", 2, 40*time.Minute)
	_, err := h.s.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	h.m.limit = func(context.Context, AgentInfo) (time.Duration, bool) { return 0, true }
	for i := 0; i < 3; i++ {
		h.now = h.now.Add(11 * time.Minute)
		h.m.scan(ctx)
	}
	require.Len(t, h.limitPosts(), 1)
	asks, err := h.s.OpenAsks(ctx, "team", h.now)
	require.NoError(t, err)
	require.Len(t, asks, 1, "one open question for the Operator")
	assert.Equal(t, "Operator", asks[0].Member)
	assert.Contains(t, asks[0].Content, "reset time not shown")
}

// A Claude agent's limit is not on its screen: it is the latest record of its transcript. The notice reads it as the live list and the resumer do, and posts
// once for the hit (a real limit record, the scrubbed one of internal/jsonl/testdata, its times moved to now).
func TestAClaudeLimitInItsTranscriptIsOnePostToo(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 40*time.Minute)
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	raw, err := os.ReadFile(filepath.Join("..", "jsonl", "testdata", "claude_limit_5h.jsonl"))
	require.NoError(t, err)
	var rec map[string]any
	require.NoError(t, json.Unmarshal(raw, &rec))
	rec["timestamp"] = h.now.Format(time.RFC3339Nano)
	rec["apiErrorParams"].(map[string]any)["rate_limit_info"].(map[string]any)["resetsAt"] = h.now.Add(time.Hour).Unix()
	line, err := json.Marshal(rec)
	require.NoError(t, err)
	dir := filepath.Join(projects, "-tmp-project")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, h.sid(2)+".jsonl"), append(line, '\n'), 0o600))
	h.agents[1].WorkingDirectory = "/tmp/project"
	h.m.claudeLimit = claudeTranscriptLimit(jsonl.NewSessionReader())

	for i := 0; i < 4; i++ {
		h.now = h.now.Add(5 * time.Minute)
		h.m.scan(ctx)
	}
	posts := h.limitPosts()
	require.Len(t, posts, 1, "one post for the hit: %q", posts)
	assert.Contains(t, posts[0], "@Orchestrator")
	assert.Contains(t, posts[0], "Dev")
	assert.Contains(t, posts[0], "claude")
	assert.Regexp(t, `resets in 5\d min`, posts[0], "the reset the record names (an hour), less the first scan's five minutes")

	// The reset has come: nothing more, and no new hit.
	h.now = h.now.Add(2 * time.Hour)
	h.m.scan(ctx)
	assert.Len(t, h.limitPosts(), 1)
}

// The open task's title is stored text: the notice quotes it defused, so a title that names a member does not mention them (#21018, the notice census).
func TestALimitNoticeDefusesTheTaskTitle(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 40*time.Minute)
	task, err := h.s.CreateTask(ctx, "team", "Ask @Orchestrator and @all about Dev: now", "", "high", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) { return time.Hour, a.SessionID == h.sid(2) }
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(ctx)
	posts := h.limitPosts()
	require.Len(t, posts, 1)
	assert.Equal(t, 1, strings.Count(posts[0], "@Orchestrator"), "only the notice's own live mention: %q", posts[0])
	assert.NotContains(t, posts[0], "@all")
	assert.NotContains(t, posts[0], "Dev: now", "the Name: form defused too")
}
