package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A board key that starts with a tilde is Coral's own (#13527): the files a no-team agent sent for review are kept under "~no-team", and a team of that key would read them. Every write that would make a board
// by naming it is refused, and no new board's name can start with one.
func TestNoBoardIsMadeWithAKeyThatStartsWithATilde(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "~no-team", "Dev", "Developer", "", nil, "all")
	assert.ErrorIs(t, err, ErrReservedBoardName, "a subscription")
	_, err = s.PostMessage(ctx, "~no-team", "Dev", "hello", nil)
	assert.ErrorIs(t, err, ErrReservedBoardName, "a message")
	known, err := s.BoardKnown(ctx, "~no-team")
	require.NoError(t, err)
	assert.False(t, known, "no board of that key exists")

	assert.NotEmpty(t, NewNameProblem("~no-team"), "a new board's name cannot start with ~")
	assert.NotEmpty(t, NewNameProblem("~x"))

	_, err = s.Subscribe(ctx, "alpha", "Dev", "Developer", "", nil, "all")
	assert.NoError(t, err, "an ordinary board is made as ever")
	assert.True(t, ReservedBoardKey("~no-team"))
	assert.False(t, ReservedBoardKey("no-team"))
	assert.False(t, ReservedBoardKey(""))
}
