package routes

import (
	"context"
	"encoding/base64"
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

// QA's boundaries for the proposals cursor and page (#13188).
func TestProposalsPagedBoundaries(t *testing.T) {
	e := newProposalEnv(t)
	for i := 0; i < 4; i++ {
		_, _, err := e.h.bs.CreateProposal(context.Background(), board.ProposalInput{Board: "team", Kind: board.ProposalTask, Title: fmt.Sprintf("p%d", i), Payload: json.RawMessage(`{}`), Proposer: "Dev"})
		require.NoError(t, err)
	}
	// exactly one page: has_more false, no cursor, no empty second page
	code, p := e.call(t, "person", http.MethodGet, "/api/board/team/proposals?limit=4", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, p["proposals"], 4)
	assert.Equal(t, false, p["has_more"])
	assert.Nil(t, p["next_cursor"])
	// one more than a page: the next page is the one row
	_, p = e.call(t, "person", http.MethodGet, "/api/board/team/proposals?limit=3", nil)
	require.Equal(t, true, p["has_more"])
	_, p = e.call(t, "person", http.MethodGet, "/api/board/team/proposals?limit=3&cursor="+p["next_cursor"].(string), nil)
	assert.Len(t, p["proposals"], 1)
	assert.Equal(t, false, p["has_more"])

	// the cursor: "i:" and a positive id
	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, bad := range []string{b64("5"), b64("b:5"), b64("I:5"), b64("i:0"), b64("i:-1"), b64("i:x"), b64("i:"), b64("i:5 ")} {
		code, _ := e.call(t, "person", http.MethodGet, "/api/board/team/proposals?cursor="+bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
		_, ok := decodeIDCursor(bad)
		assert.False(t, ok, bad)
	}
	id, ok := decodeIDCursor(b64("i:5"))
	assert.True(t, ok)
	assert.EqualValues(t, 5, id)

	// the 1,024-byte cap: 1,024 characters is accepted (leading zeros keep the id 5), 1,028 is not
	padded := func(chars int) string { return b64("i:" + strings.Repeat("0", chars*3/4-3) + "5") }
	_, ok = decodeIDCursor(padded(1024))
	assert.True(t, ok, "exactly 1,024 characters")
	_, ok = decodeIDCursor(padded(1028))
	assert.False(t, ok, "1,028 characters")
}
