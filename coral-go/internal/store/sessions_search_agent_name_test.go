package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10873 (phone pass, finding 2): the Agent column of All chats shows the agent's name, but the search matched only the transcript's text, so typing "Backend Dev", "Back" or "backend" found
// nothing for a chat whose text never says it. A search also matches the agent's name (any part of it, any case), and the text still matches as before.
func TestSearchAlsoMatchesTheAgentName(t *testing.T) {
	db := openTestDB(t)
	s := NewSessionStore(db)
	ctx := context.Background()
	add := func(id, agent, body string) {
		last := "2026-10-20T10:00:00Z"
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, FirstTimestamp: &last, LastTimestamp: &last, MessageCount: 3, FileMtime: 1, AgentName: agent}))
		require.NoError(t, s.UpsertFTS(ctx, id, body))
	}
	add("10873000-0000-4000-8000-000000000001", "Backend Dev", "fixed the tunnel retry and ran the tests")
	add("10873000-0000-4000-8000-000000000002", "QA Engineer", "the backend returned a 500 for the tunnel")
	add("10873000-0000-4000-8000-000000000003", "Frontend Dev", "restyled the header")
	find := func(q string) []string {
		t.Helper()
		res, err := s.ListSessionsPaged(ctx, SessionListParams{Search: q})
		require.NoError(t, err, q)
		var out []string
		for _, it := range res.Sessions {
			out = append(out, it.SessionID[len(it.SessionID)-1:])
		}
		return out
	}
	assert.ElementsMatch(t, []string{"1", "2"}, find("backend"), "the name of chat 1 and the text of chat 2")
	assert.Equal(t, []string{"1", "2"}, find("Backend Dev"), "a whole name finds the agent's chat first, then the chat whose text says 'backend' (words are ORed by default)")
	assert.ElementsMatch(t, []string{"1"}, find("Back"), "the start of a name, in any case (the text of chat 2 has 'backend', not the word 'back')")
	assert.Empty(t, find("100%"), "a % in a search is a character, not a wildcard")
	assert.ElementsMatch(t, []string{"3"}, find("front"), "a part of a name")
	assert.ElementsMatch(t, []string{"2"}, find("500"), "the text still matches as before")
	assert.Empty(t, find("nobody"), "no name and no text")
	add("10873000-0000-4000-8000-000000000004", "", "the tunnel worked") // a chat with no agent name is still a text hit (NOT of a NULL is not true)
	assert.Contains(t, find("tunnel"), "4", "a chat with no name stays a text hit")
	// the snippet of a text hit is still there, and a name-only hit has none
	res, err := s.ListSessionsPaged(ctx, SessionListParams{Search: "tunnel"})
	require.NoError(t, err)
	require.Len(t, res.Sessions, 3) // chats 2 and 4 say it, and chat 1's text does too ('the tunnel retry')
	for _, it := range res.Sessions {
		assert.NotEmpty(t, it.Snippet, "a text hit keeps its snippet")
	}
}

// #10873, Security's performance MUST: joining the text hits on as a subquery made a common-word search over thousands of chats take seconds (22 ms before). The text part is the plain join again; a search for a word
// in every chat, and the page after the name part's, stay fast, and a page reads the name part first then the text part without a gap or a repeat.
func TestSearchByNameStaysFastAndPagesWithoutGaps(t *testing.T) {
	db := openTestDB(t)
	s := NewSessionStore(db)
	ctx := context.Background()
	const n = 3000
	items := make([]FTSItem, 0, n)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("10873%03d0-0000-4000-8000-%012d", i%1000, i)
		agent := "Worker"
		if i%100 == 0 {
			agent = "Backend Dev" // 30 chats named for it, and the text of every chat says it too
		}
		ts := fmt.Sprintf("2026-10-20T10:%02d:%02dZ", (i/60)%60, i%60)
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, FirstTimestamp: &ts, LastTimestamp: &ts, MessageCount: 2, FileMtime: 1, AgentName: agent}))
		items = append(items, FTSItem{SessionID: id, Body: "the backend word is in every chat " + fmt.Sprint(i)})
	}
	require.NoError(t, s.UpsertFTSBatch(ctx, items))
	start := time.Now()
	res, err := s.ListSessionsPaged(ctx, SessionListParams{Search: "backend", PageSize: 50})
	require.NoError(t, err)
	assert.Equal(t, n, res.Total)
	assert.Less(t, time.Since(start), 2*time.Second, "a search for a word in every chat reads one page of them")
	// by name: the 30 agent chats first, then the rest of the text hits, over pages of 20 with none missing and none twice
	seen := map[string]bool{}
	var firstPage []SessionListItem
	for page := 1; page <= 4; page++ {
		r, err := s.ListSessionsPaged(ctx, SessionListParams{Search: "backend", Page: page, PageSize: 20})
		require.NoError(t, err)
		if page == 1 {
			firstPage = r.Sessions
		}
		for _, it := range r.Sessions {
			assert.False(t, seen[it.SessionID], "a chat once: %s", it.SessionID)
			seen[it.SessionID] = true
		}
	}
	assert.Len(t, seen, 80)
	for _, it := range firstPage {
		assert.Equal(t, "Backend Dev", it.AgentName, "the name part comes first")
	}
}
