package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10390: a past chat shows the folder it ran in, the list filters by it, and the counts offer the folders most chats ran in.
func TestChatFolderColumnFilterAndChoices(t *testing.T) {
	db := openTestDB(t)
	s := NewSessionStore(db)
	ctx := context.Background()
	last := "2026-10-20T10:00:00Z"
	for id, dir := range map[string]string{
		"10390000-0000-4000-8000-000000000001": "/srv/app",
		"10390000-0000-4000-8000-000000000002": "/srv/app",
		"10390000-0000-4000-8000-000000000003": "/srv/other",
		"10390000-0000-4000-8000-000000000004": "", // a CLI that keeps no folder
	} {
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, FirstTimestamp: &last, LastTimestamp: &last, MessageCount: 3, FileMtime: 1, WorkingDir: dir}))
	}

	all, err := s.ListSessionsPaged(ctx, SessionListParams{})
	require.NoError(t, err)
	assert.Equal(t, 4, all.Total)

	app, err := s.ListSessionsPaged(ctx, SessionListParams{Folder: "/srv/app"})
	require.NoError(t, err)
	assert.Equal(t, 2, app.Total)
	for _, row := range app.Sessions {
		assert.Equal(t, "/srv/app", row.WorkingDir)
	}

	counts, err := s.CountChatFolders(ctx, nil)
	require.NoError(t, err)
	assert.Equal(t, []ChatDirCount{{"/srv/app", 2}, {"/srv/other", 1}}, counts.Dirs, "a chat with no folder is not a choice")
}
