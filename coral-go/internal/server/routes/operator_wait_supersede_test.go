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
