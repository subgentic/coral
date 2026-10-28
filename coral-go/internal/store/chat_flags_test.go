package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChatFlagsFiltersAndFolderCounts(t *testing.T) {
	s := NewSessionStore(openTestDB(t))
	ctx := context.Background()
	yes, no := true, false
	stamp := "2026-10-25T20:00:00Z"
	index := func(id, cli string) {
		t.Helper()
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: id, SourceType: cli, SourceFile: "/fixture/" + id, FirstTimestamp: &stamp, LastTimestamp: &stamp, MessageCount: 2}))
	}
	for _, c := range []struct{ id, cli string }{{"running", "codex"}, {"sleeping", "claude"}, {"stopped", "codex"}, {"archived", "gemini"}, {"plain", "agy"}, {"zero-pid", "codex"}, {"other-cli", "claude"}} {
		index(c.id, c.cli)
	}
	for _, id := range []string{"running", "sleeping", "stopped", "zero-pid", "other-cli"} {
		cli := "codex"
		if id == "sleeping" {
			cli = "claude"
		}
		require.NoError(t, s.RegisterLiveSession(ctx, &LiveSession{SessionID: id, AgentName: id, AgentType: cli, WorkingDir: "/fixture", PID: 123, BoardName: func() *string { b := "group"; return &b }()}))
	}
	_, err := s.db.ExecContext(ctx, `UPDATE live_sessions SET is_sleeping=1 WHERE session_id='sleeping'; UPDATE live_sessions SET status='stopped' WHERE session_id='stopped'; UPDATE live_sessions SET pid=0 WHERE session_id='zero-pid'`)
	require.NoError(t, err)
	require.NoError(t, s.UpdateChatFlags(ctx, "running", &yes, nil))
	require.NoError(t, s.UpdateChatFlags(ctx, "archived", &yes, &yes))
	require.NoError(t, s.UpdateChatFlags(ctx, "board:group", &yes, nil))
	require.NoError(t, s.SaveSessionNotes(ctx, "running", "notes"))
	tag, err := s.CreateTag(ctx, "Review", "#112233")
	require.NoError(t, err)
	for _, id := range []string{"running", "archived"} {
		require.NoError(t, s.AddSessionTag(ctx, id, tag.ID))
	}
	ids := func(p SessionListParams) []string {
		t.Helper()
		p.PageSize = 50
		r, err := s.ListSessionsPaged(ctx, p)
		require.NoError(t, err)
		out := []string{}
		for _, v := range r.Sessions {
			out = append(out, v.SessionID)
		}
		return out
	}
	assert.Len(t, ids(SessionListParams{}), 6)
	assert.ElementsMatch(t, []string{"running"}, ids(SessionListParams{Starred: true}))
	assert.ElementsMatch(t, []string{"archived"}, ids(SessionListParams{Archived: true}))
	assert.ElementsMatch(t, []string{"running"}, ids(SessionListParams{Active: true}))
	_, err = s.db.ExecContext(ctx, "UPDATE live_sessions SET is_sleeping=0,is_archived=1 WHERE session_id='sleeping'")
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"running"}, ids(SessionListParams{Active: true}), "an archived live record is not active even if awake")
	assert.ElementsMatch(t, []string{"running"}, ids(SessionListParams{WithNotes: true}))
	assert.Empty(t, ids(SessionListParams{Starred: true, SourceTypes: []string{"claude"}}))
	assert.ElementsMatch(t, []string{"running"}, ids(SessionListParams{TagIDs: []int64{tag.ID}}))
	counts, err := s.CountChatFolders(ctx, []string{"group", "quiet"})
	require.NoError(t, err)
	assert.Equal(t, 5, counts.All, "All is the visible agent chats: no board, and not the archived live agent (#10086: it is in Archived)")
	assert.Equal(t, 2, counts.Group, "Group chats is every board")
	assert.Equal(t, 1, counts.Notes)
	assert.Equal(t, 2, counts.Starred, "Starred is the visible chats of both kinds: an agent chat and a board")
	assert.Equal(t, 1, counts.Active, "Active now is agent chats only: the awake board is not counted")
	assert.Equal(t, 2, counts.Archived, "the mailbox-archived chat and the archived live agent's (#10086: moved from 1, the sidebar and Inbox agree)")
	assert.Equal(t, map[string]int{"codex": 3, "claude": 1, "agy": 1, "gemini": 1, "antigravity": 1}, counts.ByAgentType)
	require.Len(t, counts.Tags, 1)
	assert.Equal(t, ChatFolderTag{tag.ID, "Review", "#112233", 1}, counts.Tags[0])
	flags, err := s.ChatFlagsForBoards(ctx, []string{"group", "quiet"})
	require.NoError(t, err)
	assert.Equal(t, ChatFlags{Starred: true, Active: true}, flags["group"])
	assert.Equal(t, ChatFlags{}, flags["quiet"])
	// Reindexing cannot overwrite the Operator's flags; updating one leaves the other alone.
	index("archived", "gemini")
	require.NoError(t, s.UpdateChatFlags(ctx, "archived", &no, nil))
	rows, err := s.ListSessionsPaged(ctx, SessionListParams{Archived: true})
	require.NoError(t, err)
	require.Len(t, rows.Sessions, 2, "the flagged chat and the archived live agent's (#10086)")
	for _, r := range rows.Sessions {
		assert.True(t, r.Archived)
		if r.SessionID == "archived" {
			assert.False(t, r.Starred)
		}
	}
	require.NoError(t, s.UpdateChatFlags(ctx, "archived", nil, &no))
	assert.Len(t, ids(SessionListParams{}), 6, "the archived live agent's chat stays out of All chats (#10086: was 7)")
	// Archiving a chat is purely a mailbox flag: a running agent remains active.
	require.NoError(t, s.UpdateChatFlags(ctx, "running", nil, &yes))
	assert.Empty(t, ids(SessionListParams{Active: true}))
	assert.ElementsMatch(t, []string{"running"}, ids(SessionListParams{Active: true, Archived: true}))
}

// #10086 (Desktop #10082): the sidebar's "Archived (1)" counts archived agents; Inbox > Archived said 0. An archived live agent's chat is in the Archived folder, counted there and out of All chats,
// and unarchiving the agent puts it back, with no chat flag written either way.
func TestArchivedAgentIsInTheArchivedChatFolder(t *testing.T) {
	s := NewSessionStore(openTestDB(t))
	ctx := context.Background()
	stamp := "2026-10-25T20:00:00Z"
	for _, id := range []string{"gone-quiet", "still-here"} {
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/fixture/" + id, FirstTimestamp: &stamp, LastTimestamp: &stamp, MessageCount: 2}))
		require.NoError(t, s.RegisterLiveSession(ctx, &LiveSession{SessionID: id, AgentName: id, AgentType: "claude", WorkingDir: "/fixture", PID: 123}))
	}
	folder := func(archived bool) []string {
		t.Helper()
		r, err := s.ListSessionsPaged(ctx, SessionListParams{PageSize: 50, Archived: archived})
		require.NoError(t, err)
		out := []string{}
		for _, v := range r.Sessions {
			out = append(out, v.SessionID)
		}
		return out
	}
	counts := func() (all, archived int) {
		t.Helper()
		c, err := s.CountChatFolders(ctx, nil)
		require.NoError(t, err)
		return c.All, c.Archived
	}
	all, archived := counts()
	assert.Equal(t, []int{2, 0}, []int{all, archived})
	require.NoError(t, s.SetSessionArchived(ctx, "gone-quiet", true))
	assert.Equal(t, []string{"gone-quiet"}, folder(true), "the archived agent's chat is in Archived")
	assert.Equal(t, []string{"still-here"}, folder(false), "and out of All chats")
	all, archived = counts()
	assert.Equal(t, []int{1, 1}, []int{all, archived}, "the folder counts agree with the list")
	var flag int
	require.NoError(t, s.db.GetContext(ctx, &flag, "SELECT COUNT(*) FROM chat_flags WHERE session_id = 'gone-quiet'"))
	assert.Zero(t, flag, "nothing is written to the chat flags: the agent's own archive is the one source")
	require.NoError(t, s.SetSessionArchived(ctx, "gone-quiet", false))
	assert.Empty(t, folder(true))
	assert.Len(t, folder(false), 2)
}
