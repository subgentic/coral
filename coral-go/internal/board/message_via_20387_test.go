package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20387 (term a): a message that arrived through a Hub link records the link and the Hub person from the stamp in the context, and a local post records neither.
func TestAMessageRecordsTheLinkAndHubPersonItArrivedThrough(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "p", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)

	via := WithActionVia(ctx, ActionVia{LinkID: "lnk-aaaa1111", HubUser: "hub-user-bbbb2222"})
	m, err := s.PostHubMessage(via, "p", "hub-user-bbbb2222", "hi", nil, false)
	require.NoError(t, err)
	require.NotNil(t, m.ViaLink)
	assert.Equal(t, "lnk-aaaa1111", *m.ViaLink)
	assert.Equal(t, "hub-user-bbbb2222", *m.ViaHubUser)

	local, err := s.PostMessage(ctx, "p", "Dev", "hello", nil)
	require.NoError(t, err)
	assert.Nil(t, local.ViaLink)
	assert.Nil(t, local.ViaHubUser)

	// A stream that named no person records the link alone.
	anon, err := s.PostMessage(WithActionVia(ctx, ActionVia{LinkID: "lnk-aaaa1111"}), "p", "Dev", "x", nil)
	require.NoError(t, err)
	assert.NotNil(t, anon.ViaLink)
	assert.Nil(t, anon.ViaHubUser)

	// The row holds the same pair.
	var rows []struct {
		Content string  `db:"content"`
		Link    *string `db:"via_link"`
		User    *string `db:"via_hub_user"`
	}
	require.NoError(t, s.db.SelectContext(ctx, &rows, `SELECT content, via_link, via_hub_user FROM board_messages WHERE project = 'p' AND via_link IS NOT NULL ORDER BY id`))
	require.Len(t, rows, 2)
	assert.Equal(t, "hi", rows[0].Content)
	assert.Equal(t, "hub-user-bbbb2222", *rows[0].User)
	assert.Nil(t, rows[1].User)
}
