package routes

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12995: a deleted board stays deleted. A page left open elsewhere keeps subscribing the Operator and saving settings; neither starts the board again. An agent's own join does (an explicit join starts a board).
func TestADeletedBoardIsNotStartedAgainByAnOpenPage(t *testing.T) {
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/gone-board"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Operator", "job_title": "Operator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Dev"}).Body.Close()
	known := func() bool { ok, err := h.bs.BoardKnown(t.Context(), "gone-board"); require.NoError(t, err); return ok }
	require.True(t, known())

	req, _ := http.NewRequest(http.MethodDelete, base, nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.False(t, known(), "deleted")

	// the open page's next poll: subscribe as the Operator, again and again
	for i := 0; i < 3; i++ {
		r := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Operator", "job_title": "Operator"})
		var out map[string]any
		_ = json.NewDecoder(r.Body).Decode(&out)
		r.Body.Close()
		assert.Equal(t, http.StatusNotFound, r.StatusCode, "%v", out)
		assert.Equal(t, "board_deleted", out["code"])
	}
	put, _ := http.NewRequest(http.MethodPut, base+"/settings", strings.NewReader(`{"subscriber_id":"Operator","require_goal":true}`))
	put.Header.Set("Content-Type", "application/json")
	pr, err := http.DefaultClient.Do(put)
	require.NoError(t, err)
	var pout map[string]any
	_ = json.NewDecoder(pr.Body).Decode(&pout)
	pr.Body.Close()
	assert.Equal(t, http.StatusNotFound, pr.StatusCode, "a settings save does not start a deleted board: %v", pout)
	assert.Equal(t, "board_deleted", pout["code"])
	assert.False(t, known(), "the page's poll did not bring the board back")

	// an agent's explicit join starts it again, and then the Operator may subscribe
	r := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Dev"})
	r.Body.Close()
	assert.Equal(t, http.StatusOK, r.StatusCode)
	assert.True(t, known())
	r = postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Operator", "job_title": "Operator"})
	r.Body.Close()
	assert.Equal(t, http.StatusOK, r.StatusCode)
}
