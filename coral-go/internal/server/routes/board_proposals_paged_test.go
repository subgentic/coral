package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13188: the proposals list says how many there are and where the next page starts; with no limit it answers as it did (every one up to 500).
func TestProposalsListPagesWithATotalAndACursor(t *testing.T) {
	e := newProposalEnv(t)
	const n = 7
	for i := 0; i < n; i++ {
		_, _, err := e.h.bs.CreateProposal(context.Background(), board.ProposalInput{Board: "team", Kind: board.ProposalTask, Title: fmt.Sprintf("proposal %d", i), Payload: json.RawMessage(`{}`), Proposer: "Dev"})
		require.NoError(t, err)
	}
	code, all := e.call(t, "person", http.MethodGet, "/api/board/team/proposals", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, all["proposals"], n, "no limit: every one, as before")
	assert.EqualValues(t, n, all["total"])
	assert.Equal(t, false, all["has_more"])
	assert.Nil(t, all["next_cursor"])

	seen := map[string]bool{}
	path, pages := "/api/board/team/proposals?limit=3", 0
	for {
		code, p := e.call(t, "person", http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, code, p)
		pages++
		assert.EqualValues(t, n, p["total"])
		for _, r := range p["proposals"].([]any) {
			title := r.(map[string]any)["title"].(string)
			require.False(t, seen[title], "sent once: "+title)
			seen[title] = true
		}
		if p["has_more"] != true {
			assert.Nil(t, p["next_cursor"])
			break
		}
		require.Len(t, p["proposals"], 3)
		path = "/api/board/team/proposals?limit=3&cursor=" + p["next_cursor"].(string)
		require.Less(t, pages, 6)
	}
	assert.Len(t, seen, n)
	assert.Equal(t, 3, pages)

	for _, bad := range []string{"limit=0", "limit=501", "limit=x", "cursor=!!!", "cursor=" + strings.Repeat("A", 1100)} {
		code, _ := e.call(t, "person", http.MethodGet, "/api/board/team/proposals?"+bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}
