package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9893: a link between two teams of this computer is an entry on the target's list; ApplyLocalLinks writes both directions in one transaction, never duplicates, removes cleanly, and
// BoardsListing finds who a sender may message.
func TestApplyLocalLinksWritesBothWaysAtomically(t *testing.T) {
	ctx := context.Background()
	bs := newAllowStore(t)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		_, err := bs.Subscribe(ctx, name, "Orchestrator", "Orchestrator", "tmux-"+name, nil, "mentions")
		require.NoError(t, err)
	}
	id := map[string]string{}
	self := map[string]string{}
	for _, name := range []string{"alpha", "beta", "gamma"} {
		x, ok, err := bs.CrossTeamID(ctx, name)
		require.NoError(t, err)
		require.True(t, ok)
		id[name], self[name] = x, x
	}
	on, off := true, false

	// both ways, files on: alpha may message beta (the entry is on beta) and beta may message alpha (on alpha)
	changes, err := bs.ApplyLocalLinks(ctx, []LocalLinkEdit{
		{Target: "beta", Sender: AllowedSender{CrossTeamID: id["alpha"], Label: "alpha", Files: &on}},
		{Target: "alpha", Sender: AllowedSender{CrossTeamID: id["beta"], Label: "beta", Files: &on}},
	}, self)
	require.NoError(t, err)
	require.Len(t, changes, 2)
	a, err := bs.GetBoardSettings(ctx, "alpha")
	require.NoError(t, err)
	b, err := bs.GetBoardSettings(ctx, "beta")
	require.NoError(t, err)
	assert.True(t, a.AllowsSender(LocalServer, id["beta"]))
	assert.True(t, b.AllowsSender(LocalServer, id["alpha"]))
	assert.True(t, b.AllowsFilesFrom(LocalServer, id["alpha"]))
	g, err := bs.GetBoardSettings(ctx, "gamma")
	require.NoError(t, err)
	assert.False(t, g.AllowsSender(LocalServer, id["alpha"]), "a third team is not linked")
	assert.False(t, b.AllowsSender(LocalServer, id["gamma"]))

	// the same again changes nothing and duplicates nothing; a new files grant updates the entry
	changes, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{{Target: "beta", Sender: AllowedSender{CrossTeamID: id["alpha"]}}}, self)
	require.NoError(t, err)
	assert.Empty(t, changes, "an entry already there changes nothing")
	changes, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{{Target: "beta", Sender: AllowedSender{CrossTeamID: id["alpha"], Files: &off}}}, self)
	require.NoError(t, err)
	require.Len(t, changes, 1)
	b, _ = bs.GetBoardSettings(ctx, "beta")
	assert.Len(t, b.CrossTeamAllowed, 1, "one entry, updated")
	assert.True(t, b.AllowsSender(LocalServer, id["alpha"]))
	assert.False(t, b.AllowsFilesFrom(LocalServer, id["alpha"]), "files turned off for this link")

	// who may alpha message
	to, err := bs.BoardsListing(ctx, id["alpha"])
	require.NoError(t, err)
	require.Len(t, to, 1)
	assert.Equal(t, "beta", to[0].Target)
	require.NotNil(t, to[0].Files)
	assert.False(t, *to[0].Files)

	// one direction removed, the other stays
	changes, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{{Target: "beta", Sender: AllowedSender{CrossTeamID: id["alpha"]}, Remove: true}}, self)
	require.NoError(t, err)
	require.Len(t, changes, 1)
	b, _ = bs.GetBoardSettings(ctx, "beta")
	a, _ = bs.GetBoardSettings(ctx, "alpha")
	assert.False(t, b.AllowsSender(LocalServer, id["alpha"]))
	assert.True(t, a.AllowsSender(LocalServer, id["beta"]))
	changes, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{{Target: "beta", Sender: AllowedSender{CrossTeamID: id["alpha"]}, Remove: true}}, self)
	require.NoError(t, err)
	assert.Empty(t, changes, "removing what is not there is fine")

	// all or none: the second edit is bad, so the first is not applied
	_, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{
		{Target: "gamma", Sender: AllowedSender{CrossTeamID: id["alpha"]}},
		{Target: "gamma", Sender: AllowedSender{CrossTeamID: "nonsense"}},
	}, self)
	require.Error(t, err)
	g, _ = bs.GetBoardSettings(ctx, "gamma")
	assert.Empty(t, g.CrossTeamAllowed, "a failed batch changes nothing")
	_, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{{Target: "gamma", Sender: AllowedSender{CrossTeamID: id["gamma"]}}}, self)
	require.Error(t, err, "a board is not linked to itself")
}

// Entries written before the files grant existed (no "files") leave files to the board's switch: still allowed.
func TestAnEntryWithNoFilesGrantStillAllowsFiles(t *testing.T) {
	b := BoardSettings{CrossTeamAllowed: []AllowedSender{{Server: LocalServer, CrossTeamID: "x-aaaaaaaaaaaaaaaa"}}}
	assert.True(t, b.AllowsFilesFrom(LocalServer, "x-aaaaaaaaaaaaaaaa"))
	assert.False(t, b.AllowsFilesFrom(LocalServer, "x-bbbbbbbbbbbbbbbb"))
	assert.False(t, b.AllowsFilesFrom("", "x-aaaaaaaaaaaaaaaa"))
}

// A stored list that cannot be read is never replaced (Security Reviewer's SHOULD on #9900): the edit fails and the value stays as it was, hub entries included.
func TestApplyLocalLinksNeverReplacesAListItCannotRead(t *testing.T) {
	ctx := context.Background()
	bs := newAllowStore(t)
	for _, name := range []string{"alpha", "beta"} {
		_, err := bs.Subscribe(ctx, name, "Orchestrator", "Orchestrator", "tmux-"+name, nil, "mentions")
		require.NoError(t, err)
	}
	a, _, err := bs.CrossTeamID(ctx, "alpha")
	require.NoError(t, err)
	_, err = bs.db.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES ('beta', 'cross_team_allowed', 'not json {"server":"hub-1"')`)
	require.NoError(t, err)
	_, err = bs.ApplyLocalLinks(ctx, []LocalLinkEdit{{Target: "beta", Sender: AllowedSender{CrossTeamID: a}}}, map[string]string{})
	require.Error(t, err, "an unreadable list is an error, not an empty one")
	var raw string
	require.NoError(t, bs.db.GetContext(ctx, &raw, `SELECT value FROM board_settings WHERE project = 'beta' AND key = 'cross_team_allowed'`))
	assert.Equal(t, `not json {"server":"hub-1"`, raw, "and it is left exactly as it was")
}
