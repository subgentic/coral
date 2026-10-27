package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// #9265: every server post that quotes stored text (a task title, a completion message, a review note or reason, a candidate, a park reason) is defused: it tags no member through "@" or through
// the "Name:", "Name —" and "Name—" forms. A bystander who reads only what tags them (mentions mode) is the probe.

const bystander = "Docs Writer"

func tagsBoard(t *testing.T, project string) (base func(int64, string) string, h *BoardHandler, root string) {
	t.Helper()
	base, h, first := reviewTeam(t, project, true)
	_, err := h.bs.CompleteTask(context.Background(), project, first.ID, "worker", nil) // the worker's slot is free for the test's own tasks
	require.NoError(t, err)
	_, err = h.bs.Subscribe(context.Background(), project, bystander, bystander, "dw-session", nil, "mentions")
	require.NoError(t, err)
	return base, h, strings.TrimSuffix(base(0, "x"), "/tasks/0/x")
}

func noOneTagged(t *testing.T, h *BoardHandler, project string, what string) {
	t.Helper()
	got, err := h.bs.ReadMessages(context.Background(), project, bystander, 200) // not readAll: only what tags the member
	require.NoError(t, err)
	for _, m := range got {
		if strings.HasPrefix(m.Content, "@notify-all") {
			continue // the broadcast of an unassigned task is meant for everyone; what it quotes is what these tests probe
		}
		assert.Failf(t, what, "%s was tagged by %q", bystander, m.Content)
	}
}

func readable(t *testing.T, h *BoardHandler, project string) string {
	t.Helper()
	all, err := h.bs.ListMessages(context.Background(), project, 500, 0, 0)
	require.NoError(t, err)
	var text string
	for _, m := range all {
		text += clitext.Clean(m.Content) + "\n" // Clean drops the zero-width spaces: what a reader sees
	}
	return text
}

func TestAssignmentNoticesQuoteATitleWithoutTaggingAnyone(t *testing.T) {
	_, h, _ := tagsBoard(t, "assign")
	ctx := context.Background()
	for name, mk := range map[string]func(*board.Task){
		"blocked":    func(tk *board.Task) { tk.Status = "blocked" },
		"unassigned": func(tk *board.Task) {},
		"assigned":   func(tk *board.Task) {},
	} {
		tk := &board.Task{ID: 5, Title: "Docs Writer: ship it", Status: "pending", Priority: "high"}
		mk(tk)
		assignee := "worker"
		if name == "unassigned" {
			assignee = ""
		}
		h.postNotice(ctx, "assign", h.buildAssignmentNotification(ctx, "assign", tk, assignee, false))
		h.postNotice(ctx, "assign", h.buildAssignmentNotification(ctx, "assign", tk, assignee, true))
	}
	parked := &board.Task{ID: 6, Title: "Fix Docs Writer — now", Status: "pending", Priority: "low"}
	why := "Docs Writer: waiting for the release"
	until := "2099-01-01T00:00:00Z"
	parked.ParkedUntil, parked.ParkedReason = &until, &why
	h.postNotice(ctx, "assign", h.buildAssignmentNotification(ctx, "assign", parked, "worker", false))
	noOneTagged(t, h, "assign", "an assignment notice tagged a bystander")
	assert.Contains(t, readable(t, h, "assign"), "Docs Writer: ship it", "the words are still there")
}

func TestTaskLifecycleNoticesQuoteWhatWasWrittenWithoutTaggingAnyone(t *testing.T) {
	base, h, root := tagsBoard(t, "life")
	// create (a planner's title), claim, then complete with a worker-written message
	code, out := postCode(t, root+"/tasks", map[string]any{"title": "Docs Writer: build it", "created_by": "lead", "assigned_to": "worker"})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	id := int64(out["id"].(float64))
	code, out = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "worker"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(id, "complete"), map[string]any{"subscriber_id": "worker", "message": "Docs Writer: done, tell Docs Writer — now", "outcome": "success"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	// cancel a second task whose dependants stall
	code, out = postCode(t, root+"/tasks", map[string]any{"title": "Docs Writer — cancel me", "created_by": "lead"})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	cid := int64(out["id"].(float64))
	code, out = postCode(t, base(cid, "cancel"), map[string]any{"subscriber_id": "lead"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	h.WaitBackground()
	noOneTagged(t, h, "life", "a lifecycle notice tagged a bystander")
	text := readable(t, h, "life")
	assert.Contains(t, text, "Docs Writer: build it")
	assert.Contains(t, text, "Docs Writer: done, tell Docs Writer — now", "the completion message is quoted whole")
	assert.Contains(t, text, "Docs Writer — cancel me")
}

func TestReviewNoticesQuoteReasonCandidateAndNotesWithoutTaggingAnyone(t *testing.T) {
	base, h, _ := tagsBoard(t, "rev")
	ctx := context.Background()
	task, err := h.bs.CreateTask(ctx, "rev", "Docs Writer: build the report", "", "high", "lead", "worker")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "rev", "worker", task.ID)
	require.NoError(t, err)
	code, out := postCode(t, base(task.ID, "submit-review"), map[string]any{"subscriber_id": "worker", "reason": "Docs Writer: ready", "candidate_revision": "Docs Writer — rev 2", "message": "built it", "artifacts": []board.TaskArtifact{{Name: "report", Content: "done"}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(task.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"Security Reviewer", "QA Engineer"}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(task.ID, "reject"), map[string]any{"subscriber_id": "Security Reviewer", "note": "Docs Writer: not safe", "round": 1})
	require.Equal(t, http.StatusOK, code, "%v", out)
	// resubmitted after the rejection: the notice to the orchestrator quotes the reason again
	_, err = h.bs.ClaimTask(ctx, "rev", "worker", task.ID)
	require.NoError(t, err)
	code, out = postCode(t, base(task.ID, "submit-review"), map[string]any{"subscriber_id": "worker", "reason": "Docs Writer: fixed", "candidate_revision": "Docs Writer—rev 3", "message": "fixed", "artifacts": []board.TaskArtifact{{Name: "report", Content: "done 2"}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	for _, who := range []string{"Security Reviewer", "QA Engineer"} {
		code, out = postCode(t, base(task.ID, "approve"), map[string]any{"subscriber_id": who, "note": "Docs Writer — fine"})
		require.Equal(t, http.StatusOK, code, "%v", out)
	}
	h.WaitBackground()
	noOneTagged(t, h, "rev", "a review notice tagged a bystander")
	text := readable(t, h, "rev")
	assert.Contains(t, text, "Docs Writer: ready")
	assert.Contains(t, text, "Docs Writer: not safe")
	assert.Contains(t, text, "Docs Writer — fine")
}

// A notice still tags the people it means to: the positive control for the probes above.
func TestANoticeStillTagsItsAssignee(t *testing.T) {
	_, h, _ := tagsBoard(t, "ctl")
	ctx := context.Background()
	tk := &board.Task{ID: 9, Title: "Plain title", Status: "pending", Priority: "high"}
	h.postNotice(ctx, "ctl", h.buildAssignmentNotification(ctx, "ctl", tk, bystander, false))
	got, err := h.bs.ReadMessages(ctx, "ctl", bystander, 50)
	require.NoError(t, err)
	require.Len(t, got, 1, "the assignee is tagged by the notice that means to")
}

// The review pool's line (#8957) quotes the title, the candidate and the reason: each is probed alone, on its own board, with the others plain, so a part left raw cannot hide behind one that is defused.
func TestReviewPoolLineQuotesEachOfTitleCandidateAndReasonWithoutTaggingAnyone(t *testing.T) {
	for _, c := range []struct{ name, title, candidate, reason, words string }{
		{"title", "Docs Writer: pooled build", "rev 1", "ready", "Docs Writer: pooled build"},
		{"candidate", "Pooled build", "Docs Writer — rev 1", "ready", "Docs Writer — rev 1"},
		{"reason", "Pooled build", "rev 1", "Docs Writer: ready", "Docs Writer: ready"},
	} {
		t.Run(c.name, func(t *testing.T) {
			project := "pool-" + c.name
			base, h, _ := tagsBoard(t, project)
			ctx := context.Background()
			_, err := h.bs.Subscribe(ctx, project, "Rev Only", "Reviewer", "ro-session", nil, "all")
			require.NoError(t, err)
			yes, none := true, []string{}
			_, err = h.bs.SetReviewSettings(ctx, project, "Rev Only", &yes, &none)
			require.NoError(t, err)
			task, err := h.bs.CreateTask(ctx, project, c.title, "", "high", "lead", "worker")
			require.NoError(t, err)
			_, err = h.bs.ClaimTask(ctx, project, "worker", task.ID)
			require.NoError(t, err)
			code, out := postCode(t, base(task.ID, "submit-review"), map[string]any{"subscriber_id": "worker", "reason": c.reason, "candidate_revision": c.candidate, "message": "built", "artifacts": []board.TaskArtifact{{Name: "report", Content: "done"}}})
			require.Equal(t, http.StatusOK, code, "%v", out)
			h.WaitBackground()
			noOneTagged(t, h, project, "the pool line tagged a bystander through its "+c.name)
			text := readable(t, h, project)
			assert.Contains(t, text, "in the review pool")
			assert.Contains(t, text, c.words, "the quoted part is readable whole")
		})
	}
}

// A blocked task's creation notice names what it waits for, and the reason for a dependency is built from stored text (a required artifact's name): it is quoted data too.
func TestBlockedCreationNoticeQuotesTheBlockerReasonWithoutTaggingAnyone(t *testing.T) {
	_, h, root := tagsBoard(t, "blk")
	ctx := context.Background()
	up, err := h.bs.CreateTask(ctx, "blk", "Upstream", "", "medium", "lead")
	require.NoError(t, err)
	code, out := postCode(t, root+"/tasks", map[string]any{"title": "Downstream", "created_by": "lead", "blocked_by": []map[string]any{{"task_id": up.ID, "required_artifacts": []string{"Docs Writer: spec"}}}})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	h.WaitBackground()
	noOneTagged(t, h, "blk", "the blocked notice tagged a bystander through the blocker reason")
	assert.Contains(t, readable(t, h, "blk"), "missing required artifacts: Docs Writer: spec", "the reason is quoted whole")
}

// A member's id can hold a name and a colon ("Docs Writer: Lead"): when that member sends a task back, the notice names them without tagging the member the id begins with.
func TestSendBackNoticeQuotesTheSendersIdWithoutTaggingAnyone(t *testing.T) {
	base, h, _ := tagsBoard(t, "sb")
	ctx := context.Background()
	const sender = "Docs Writer: Lead"
	_, err := h.bs.Subscribe(ctx, "sb", sender, "Orchestrator", "sb-session", nil, "all")
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "sb", "Merge queue task", "", "high", "lead", "worker")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "sb", "worker", task.ID)
	require.NoError(t, err)
	patch := board.TaskArtifact{Name: "fix.patch", Content: "diff --git a/a b/a", Revision: "r1"}
	code, out := postCode(t, base(task.ID, "submit-review"), map[string]any{"subscriber_id": "worker", "reason": "ready", "message": "built", "artifacts": []board.TaskArtifact{patch}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(task.ID, "review"), map[string]any{"subscriber_id": "lead", "reviewers": []string{"Security Reviewer"}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(task.ID, "approve"), map[string]any{"subscriber_id": "Security Reviewer"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = postCode(t, base(task.ID, "send-back"), map[string]any{"subscriber_id": sender, "note": "conflicts in a.go"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	h.WaitBackground()
	noOneTagged(t, h, "sb", "the send-back notice tagged a bystander through the sender's id")
	assert.Contains(t, readable(t, h, "sb"), "sent back by "+sender, "the sender is named whole")
}

func TestQuoteNoticeEscapesQuotesAndKeepsTheZeroWidthSpaces(t *testing.T) {
	assert.Equal(t, "\"say \\\"hi\\\" a\\\\b Docs Writer\u200b: x\"", quoteNotice("say \"hi\" a\\b Docs Writer\u200b: x"))
}
