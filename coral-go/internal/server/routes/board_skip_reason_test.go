package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// boardText is every message on the board as one string, for a test that asks what the board was told.
func wholeBoardText(t *testing.T, base string) string {
	t.Helper()
	resp, err := http.Get(base + "/messages/all")
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func skipBody(who string, message *string) map[string]any {
	m := map[string]any{"subscriber_id": who}
	if message != nil {
		m["message"] = *message
	}
	return m
}

// #17614: a skipped task with no words behind it dropped a release blocker unseen. A member needs a reason, it is kept as the completion message and
// posted on the board; the Operator's dashboard buttons, which ask for none, store plain words.
func TestSkippingATaskNeedsAReasonAndTheBoardSeesIt(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "myproject", "Orchestrator")
	base := server.URL + "/api/board/myproject"
	mk := func(title, prio string) float64 {
		resp := postJSON(t, base+"/tasks", map[string]string{"title": title, "created_by": "Orchestrator", "priority": prio})
		defer resp.Body.Close()
		var task map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&task))
		return task["id"].(float64)
	}
	cancel := func(id float64, body map[string]any) (int, map[string]any) {
		resp := postJSON(t, base+"/tasks/"+strconv.Itoa(int(id))+"/cancel", body)
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	empty, blanks := "", "   "
	why := "the tag moved to #17604"

	high := mk("Trim app.js", "high")
	for _, m := range []*string{nil, &empty, &blanks} {
		code, body := cancel(high, skipBody("Orchestrator", m))
		assert.Equal(t, http.StatusBadRequest, code, "a skip with no reason is refused")
		assert.Equal(t, "reason_required", body["code"])
	}
	code, task := cancel(high, skipBody("Orchestrator", &why))
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "skipped", task["status"])
	assert.Equal(t, why, task["completion_message"], "the reason is the completion message")

	h.WaitBackground()
	text := wholeBoardText(t, base)
	assert.Contains(t, text, "the tag moved to #17604", "the reason is posted on the board")
	assert.Contains(t, text, "@Orchestrator [high task #", "a skipped High task tells the Orchestrator")

	low := mk("Tidy", "low")
	code, _ = cancel(low, skipBody("Orchestrator", &why))
	require.Equal(t, http.StatusOK, code)
	h.WaitBackground()
	assert.Equal(t, 1, strings.Count(wholeBoardText(t, base), "@Orchestrator [high task #"), "a low task gets no Orchestrator notice")

	op := mk("From the dashboard", "medium")
	code, task = cancel(op, skipBody("Operator", nil))
	require.Equal(t, http.StatusOK, code, "the Operator's dashboard button still works")
	assert.Equal(t, noReasonGiven, task["completion_message"])
}
