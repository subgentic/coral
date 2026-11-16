package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// An agent renamed in the dashboard keeps its board id ("QA Engineer"): the board knows nobody called "Bug Hunter", so a CLI post
// "@Bug Hunter ..." was refused as an unknown mention while "@QA Engineer ..." still reached them (#17421, walk 68). The live display
// name now counts: the post is stored with the member's board id, so it reaches them, and the old name keeps working.
func TestAPostMentioningARenamedAgentByItsNewNameReachesThem(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "QA Engineer", "QA Engineer", "claude-11111111-0000-0000-0000-000000000000", nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	post := func(content string) (int, string) {
		resp := postJSON(t, server.URL+"/api/board/team/messages", map[string]string{"subscriber_id": "Orchestrator", "content": content})
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	code, _ := post("@QA Engineer please take #3")
	assert.Equal(t, 200, code, "the old name still names the member (it is their board id)")
	code, _ = post("@Bug Hunter are you there?")
	assert.Equal(t, 400, code, "before the lookup: nobody on the board is called Bug Hunter")

	h.SetMemberNameLookup(func(ctx context.Context, project string) map[string]string {
		return map[string]string{"QA Engineer": "Bug Hunter"} // the board id to the live display name
	})
	code, body := post("@Bug Hunter are you there? @bug hunter, and @Bug Hunters is not them")
	require.Equal(t, 200, code, body)
	code, body = post("@Bug Hunter are you there? Also @bug hunter, thanks")
	require.Equal(t, 200, code, body)
	msgs, err := h.bs.ListMessages(ctx, "team", 10, 0, 0)
	require.NoError(t, err)
	var last, prefixOnly string
	for _, m := range msgs {
		last = m.Content
		if m.Content == "@QA Engineer are you there? @QA Engineer, and @Bug Hunters is not them" {
			prefixOnly = m.Content // a name that only starts with the display name is left as written
		}
		if m.Content == "@QA Engineer are you there? Also @QA Engineer, thanks" {
			assert.NotEmpty(t, prefixOnly, "@Bug Hunters stays as written")
			return // stored with the board id, so the mention index and the unread count see the agent
		}
	}
	t.Fatalf("the post is stored with the member's board id; last stored: %q", last)
}

// The dashboard's rows, avatars and Reply name a renamed agent by the name it has now; the stored text and the id are the board's own, and the CLI's read keeps the job title.
func TestTheDashboardsRowsSayARenamedAgentsCurrentName(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "QA Engineer", "QA Engineer", "claude-11111111-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	for _, who := range []string{"QA Engineer", "Orchestrator"} {
		resp := postJSON(t, server.URL+"/api/board/team/messages", map[string]string{"subscriber_id": who, "content": "hello from " + who})
		resp.Body.Close()
		require.Equal(t, 200, resp.StatusCode)
	}
	titles := func(query string) []string {
		resp, err := http.Get(server.URL + "/api/board/team/messages/all?" + query)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var page struct {
			Messages []struct {
				SubscriberID string `json:"subscriber_id"`
				JobTitle     string `json:"job_title"`
			} `json:"messages"`
		}
		require.NoError(t, json.Unmarshal(b, &page), string(b))
		var out []string
		for _, m := range page.Messages {
			out = append(out, m.SubscriberID+"="+m.JobTitle)
		}
		return out
	}
	assert.ElementsMatch(t, []string{"QA Engineer=QA Engineer", "Orchestrator=Orchestrator"}, titles("format=dashboard&limit=10"))
	h.SetMemberNameLookup(func(ctx context.Context, project string) map[string]string {
		return map[string]string{"QA Engineer": "Bug Hunter"}
	})
	assert.ElementsMatch(t, []string{"QA Engineer=Bug Hunter", "Orchestrator=Orchestrator"}, titles("format=dashboard&limit=10"), "the dashboard's page says the new name; the id stays")
}

// A rename cannot take the Operator's name or a broadcast word: the dashboard's rows and the mention path would put an agent under it (Security, #17421). Real stores: the display name set
// through the session store, read through the lookup the server uses, and through a post.
func TestARenameToTheOperatorOrAllIsNotACurrentName(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	_, err = h.bs.Subscribe(ctx, "team", "QA Engineer", "QA Engineer", "claude-11111111-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	h.SetMemberNameLookup(MemberDisplayNames(h.bs, ss))
	for _, name := range []string{"Operator", "operator", "all", "ALL", "notify-all", "notify_all", "NotifyAll"} {
		require.NoError(t, ss.SetDisplayName(ctx, "11111111-0000-0000-0000-000000000000", name))
		assert.Empty(t, h.memberNames(ctx, "team"), "%q is not a name a rename may take", name)
		resp := postJSON(t, server.URL+"/api/board/team/messages", map[string]string{"subscriber_id": "Orchestrator", "content": "@" + name + " need a decision"})
		resp.Body.Close()
	}
	msgs, err := h.bs.ListMessages(ctx, "team", 20, 0, 0)
	require.NoError(t, err)
	for _, m := range msgs {
		assert.NotContains(t, m.Content, "@QA Engineer", "a reserved word stays as written, it does not reach the renamed agent")
	}
	require.NoError(t, ss.SetDisplayName(ctx, "11111111-0000-0000-0000-000000000000", "Bug Hunter"))
	assert.Equal(t, map[string]string{"QA Engineer": "Bug Hunter"}, h.memberNames(ctx, "team"), "an ordinary new name still counts")
}

// A rename cannot take the id or job title of a member who has left: an @mention meant for them would reach the new holder (Security, #17421; #17720).
func TestARenameToAFormerMembersNameIsNotACurrentName(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	_, err = h.bs.Subscribe(ctx, "team", "QA Engineer", "QA Engineer", "claude-11111111-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Old Dev", "Retired Title", "claude-33333333-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Unsubscribe(ctx, "team", "Old Dev")
	require.NoError(t, err)
	h.SetMemberNameLookup(MemberDisplayNames(h.bs, ss))
	for _, name := range []string{"Old Dev", "old dev", "Retired Title"} {
		require.NoError(t, ss.SetDisplayName(ctx, "11111111-0000-0000-0000-000000000000", name))
		assert.Empty(t, h.memberNames(ctx, "team"), "%q belonged to a member who left", name)
	}
	require.NoError(t, ss.SetDisplayName(ctx, "11111111-0000-0000-0000-000000000000", "Bug Hunter"))
	assert.Equal(t, map[string]string{"QA Engineer": "Bug Hunter"}, h.memberNames(ctx, "team"))
}
