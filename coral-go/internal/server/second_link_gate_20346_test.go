package server

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #20346, Security 1: a second link is allowed only when no tunnel write is still pending in the pair census (the Manager is still one connector, and a write that does not record the pair would be
// attributed to the wrong Hub). While the list is not empty the store's switch must stay off, so lifting it is its own reviewed change.
func TestSecondLinkSwitchStaysOffWhileAWriteIsPending(t *testing.T) {
	raw, err := os.ReadFile("testdata/pair_census.golden")
	require.NoError(t, err)
	pending := 0
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.HasSuffix(strings.TrimSpace(l), " pending") {
			pending++
		}
	}
	if store.SecondLinkOpen {
		assert.Zero(t, pending, "SecondLinkOpen is true while %d tunnel writes are still pending in pair_census.golden", pending)
	}
	assert.Positive(t, pending, "the census lists pending writes today; when it is empty, this test is the reminder to review lifting SecondLinkOpen")
}
