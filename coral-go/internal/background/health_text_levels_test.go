package background

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #20496: the lines of the rules that had no text level read one now (claim_nudge, status_nudge, mention_renudge, ask_reminder, goals_ready, auto_delegate, deviations, landing, release): normal is the line every
// team has always had (pinned here word for word), short is shorter, long says more and starts with the normal line's number and name.
func TestTheNudgeLinesReadTheirRulesTextLevel(t *testing.T) {
	short, long := board.RuleRoute{Text: board.TextShort}, board.RuleRoute{Text: board.TextLong}
	at := time.Date(2026, 11, 22, 9, 30, 0, 0, time.UTC)
	type line struct {
		name                string
		short, normal, long string
		want                string // the normal line as shipped before
	}
	for _, c := range []line{
		{"claim", claimNudgeText(short, 7), claimNudgeText(board.RuleRoute{}, 7), claimNudgeText(long, 7),
			"[Coral] #7 is assigned to you and waiting. Run 'coral-board task claim 7' to start it."},
		{"status", statusNudgeText(short, 7, 30), statusNudgeText(board.RuleRoute{}, 7, 30), statusNudgeText(long, 7, 30),
			"[Coral] No activity on #7 for 30 minutes. Post a one-line summary of progress or what you need and from whom: coral-board post --task 7 \"...\""},
		{"mention", mentionRenudgeText(short, "Dev", 1, at), mentionRenudgeText(board.RuleRoute{}, "Dev", 1, at), mentionRenudgeText(long, "Dev", 1, at),
			"[Coral] " + board.TypedLabel("Dev") + " mentioned you at 09:30 and has no answer yet. Run 'coral-board read'."},
		{"mentions", mentionRenudgeText(short, "Dev", 3, at), mentionRenudgeText(board.RuleRoute{}, "Dev", 3, at), mentionRenudgeText(long, "Dev", 3, at),
			"[Coral] " + board.TypedLabel("Dev") + " mentioned you 3 times since 09:30 and has no answer yet. Run 'coral-board read'."},
		{"ask", askReminderText(short, "Dev", 20, 31), askReminderText(board.RuleRoute{}, "Dev", 20, 31), askReminderText(long, "Dev", 20, 31),
			"[Coral] " + board.TypedLabel("Dev") + " asked you a question 20 min ago and has no answer from you yet, message #31. Run 'coral-board read' to see it, and answer with: coral-board post --reply-to 31 \"...\""},
		{"goal done", goalDoneNudgeText(short, 12, 15), goalDoneNudgeText(board.RuleRoute{}, 12, 15), goalDoneNudgeText(long, 12, 15),
			"[Coral] Goal #12's tasks are all done. If more work is planned, add it with coral-board task add \"...\" --goal 12; otherwise do nothing: it goes to the Operator in 15 minutes."},
	} {
		assert.Equal(t, c.want, c.normal, c.name+": the default line is unchanged")
		assert.Less(t, len(c.short), len(c.normal), c.name+": short is shorter")
		assert.Greater(t, len(c.long), len(c.normal), c.name+": long says more")
		assert.True(t, strings.HasPrefix(c.long, strings.SplitN(c.normal, ".", 2)[0]), c.name+": long starts as normal does: "+c.long)
	}
	// an unset or unknown level is the normal line
	assert.Equal(t, claimNudgeText(board.RuleRoute{}, 7), claimNudgeText(board.RuleRoute{Text: "loud"}, 7))
}

func TestTheOtherLinesTrimTheirArgumentsAtTheShortLevel(t *testing.T) {
	short := board.RuleRoute{Text: board.TextShort}
	assert.Equal(t, []any{"main", "2 h"}, landingArgs(short, "main", "2 h", "3 tasks"))
	assert.Equal(t, []any{"main", "2 h", "3 tasks"}, landingArgs(board.RuleRoute{}, "main", "2 h", "3 tasks"))
	assert.Len(t, releaseArgs(short, "main", "2 commits", "3 tasks", "v1", 4), 4)
	assert.Len(t, releaseArgs(board.RuleRoute{}, "main", "2 commits", "3 tasks", "v1", 4), 5)
	assert.Len(t, devArgs(short, int64(1), "5 h", "1 h", "its last 5", "2 h"), 3)
	assert.Len(t, devArgs(board.RuleRoute{}, int64(1), "5 h", "1 h", "its last 5", "2 h"), 5)
}

// held_notice.text: the line to the Operator names who is held at their level; the short one drops the explanation, the long one adds to it, and Security's rule (names only, nothing of the screen) holds at each.
func TestTheHeldNoticeReadsItsTextLevel(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	subs := []board.Subscriber{{SubscriberID: "Codex Tester", SessionName: "codex-1"}, {SubscriberID: "QA Engineer", SessionName: "claude-3"}}
	take := func(string, string, time.Duration) bool { return true }
	lines := map[string][]string{}
	for _, level := range []string{board.TextShort, "", board.TextLong} {
		bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
		require.NoError(t, err)
		h := &HealthNudges{
			store:       bs,
			now:         func() time.Time { return now },
			heldDialogs: func() map[string]time.Time { return map[string]time.Time{"claude-3": now.Add(-20 * time.Minute)} },
			heldDrafts:  func() map[string]time.Time { return map[string]time.Time{"codex-1": now.Add(-15 * time.Minute)} },
		}
		hs := board.DefaultHealthSettings()
		hs.HeldNotice.Text = level
		h.heldNotices(ctx, "team", subs, now, hs, take)
		msgs, err := bs.ListMessages(ctx, "team", 100, 0, 0)
		require.NoError(t, err)
		for _, m := range msgs {
			lines[level] = append(lines[level], m.Content)
		}
		bs.Close()
	}
	require.Len(t, lines[""], 2)
	for i := range lines[""] {
		assert.Less(t, len(lines[board.TextShort][i]), len(lines[""][i]), "short is shorter")
		assert.Greater(t, len(lines[board.TextLong][i]), len(lines[""][i]), "long says more")
	}
	for _, l := range lines[board.TextShort] {
		assert.True(t, strings.Contains(l, "Codex Tester (15 min)") || strings.Contains(l, "QA Engineer (20 min)"), l)
		assert.NotContains(t, l, "Coral never sends or clears that text", "the short line leaves the explanation out")
	}
	assert.Contains(t, strings.Join(lines[""], "\n"), "Coral never sends or clears that text.", "normal is the line as it was")
}
