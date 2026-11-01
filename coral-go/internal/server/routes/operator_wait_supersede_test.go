package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11919 (Mobile Beta Tester): an agent's second `wait --operator` replaces its first wait (an agent waits on one thing per board), and the first question fell out of the Operator's Needs you unanswered. A question
// the person has not answered is never lost that way: the replaced one stays as an ordinary open question (an ask) from the same agent, answered or closed like any other.
func TestASecondOperatorWaitDoesNotLoseTheFirstQuestion(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Lead", "Orchestrator", "claude-lead", nil, "all")
	require.NoError(t, err)
	wait := func(reason string) {
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/waits", strings.NewReader(`{"subscriber_id":"Lead","wait_type":"operator","reason":`+jsonString(reason)+`}`))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.RegisterWait(w, dropAt2(asPerson(req), map[string]string{"project": "team"}))
		require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	}
	wait("Decision 2: keep the old table or drop it?")
	_, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Len(t, rows, 1)
	wait("Decision 4: ship on Friday?")
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	var texts []string
	for _, r := range rows {
		texts = append(texts, r["text"].(string))
	}
	require.Len(t, rows, 2, "both questions are in Needs you: %v", texts)
	assert.Contains(t, strings.Join(texts, " | "), "Decision 2: keep the old table or drop it?")
	assert.Contains(t, strings.Join(texts, " | "), "Decision 4: ship on Friday?")

	wait("Decision 4: ship on Friday?") // the same question registered again (a re-issued wait) is not carried twice
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	assert.Len(t, rows, 2, "an identical wait adds nothing")

	wait("Decision 6: who reviews?")
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	assert.Len(t, rows, 3, "a third question keeps the two before it")
}

// #11919, QA's MUST: the question is kept wherever it would be cancelled by anything but the Operator's answer or the agent's own `wait --cancel`: (a) a wait of another type replaces it, (b) the agent posts,
// claims a task or completes one (endOwnWaits). Both failed before. And `wait --cancel` is the agent withdrawing the question: it is not kept.
func TestAnOperatorQuestionSurvivesAWaitOfAnotherTypeAndTheAgentWorkingAgain(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Lead", "Orchestrator", "claude-lead", nil, "all")
	require.NoError(t, err)
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/waits", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.RegisterWait(w, dropAt2(asPerson(req), map[string]string{"project": "team"}))
		return w
	}
	texts := func() string {
		_, rows, _ := readOperatorAsks(t, h, asPerson)
		var out []string
		for _, r := range rows {
			out = append(out, r["text"].(string))
		}
		return strings.Join(out, " | ")
	}
	count := func() int { _, rows, _ := readOperatorAsks(t, h, asPerson); return len(rows) }

	// (a) a wait of another type
	require.Equal(t, http.StatusCreated, post(`{"subscriber_id":"Lead","wait_type":"operator","reason":"Decision 2: drop the table?"}`).Code)
	require.Equal(t, 1, count())
	require.Equal(t, http.StatusCreated, post(`{"subscriber_id":"Lead","wait_type":"message","target_id":"Dev","reason":"waiting on Dev"}`).Code)
	assert.Contains(t, texts(), "Decision 2: drop the table?", "a wait --message did not take the question away")

	// (b) the agent gets back to work: it posted, claimed a task or completed one
	require.Equal(t, http.StatusCreated, post(`{"subscriber_id":"Lead","wait_type":"operator","reason":"Decision 4: ship Friday?"}`).Code)
	require.Equal(t, 2, count())
	h.endOwnWaits(ctx, "team", "Lead")
	assert.Contains(t, texts(), "Decision 4: ship Friday?", "an agent that is working again did not take its question away")
	assert.Equal(t, 2, count())
	h.endOwnWaits(ctx, "team", "Lead")
	assert.Equal(t, 2, count(), "ending the waits again adds nothing")

	// the same question, once as a wait and once as an ask, with a trailing space: one row
	require.Equal(t, http.StatusCreated, post(`{"subscriber_id":"Lead","wait_type":"operator","reason":"Decision 6: who reviews? "}`).Code)
	require.Equal(t, http.StatusCreated, post(`{"subscriber_id":"Lead","wait_type":"operator","reason":"Decision 6: who reviews?"}`).Code)
	assert.Equal(t, 3, count(), "the same question again is the same question: 2 kept + this one, no copy")

	// wait --cancel is the agent withdrawing it: not kept
	cancel := httptest.NewRequest(http.MethodDelete, "/api/board/team/waits?subscriber_id=Lead", nil)
	w := httptest.NewRecorder()
	h.CancelWait(w, dropAt2(asPerson(cancel), map[string]string{"project": "team"}))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, 2, count(), "the withdrawn question is gone; the kept ones stay")
}

// An agent that asked with post --ask AND parked on `wait --operator` with the same words has one question, not two: when the wait ends, nothing is added.
func TestAQuestionAskedAndWaitedOnIsNotKeptAsASecondCopy(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Lead", "Orchestrator", "claude-lead", nil, "all")
	require.NoError(t, err)
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator Decision 8: ship it?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	req := httptest.NewRequest(http.MethodPost, "/api/board/team/waits", strings.NewReader(`{"subscriber_id":"Lead","wait_type":"operator","reason":"decision 8: ship it? "}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.RegisterWait(w, dropAt2(asPerson(req), map[string]string{"project": "team"}))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	_, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Len(t, rows, 2, "the ask and the wait are both listed while the wait lasts")
	h.endOwnWaits(ctx, "team", "Lead")
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	assert.Len(t, rows, 1, "the wait ends and the ask is the one question: no second copy is kept")
}
