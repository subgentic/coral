package server

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #20346, Security 1, and #20444: a second link is allowed only when no tunnel write is pending in the pair census AND Security has signed off what is still open. The census is now empty (#20369), but the switch
// stays OFF while Security's items are open: #20405 (WebSocket upgrade rows, the refused-row cap), #20413 and the second-Hub sign-in. Lifting store.SecondLinkOpen is its own reviewed change, never made here:
// when those are closed, change this test with that review.
func TestSecondLinkSwitchStaysOffWhileAWriteIsPending(t *testing.T) {
	raw, err := os.ReadFile("testdata/pair_census.golden")
	require.NoError(t, err)
	pending := 0
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.HasSuffix(strings.TrimSpace(l), " pending") {
			pending++
		}
	}
	if pending > 0 {
		assert.False(t, store.SecondLinkOpen, "SecondLinkOpen is true while %d tunnel writes are still pending in pair_census.golden", pending)
	}
	openSecurityItems := []string{"#20405 (WebSocket upgrade rows, refused-row cap)", "#20413", "second-Hub sign-in"}
	assert.False(t, store.SecondLinkOpen, "SecondLinkOpen must stay false while Security's items are open: %s", strings.Join(openSecurityItems, ", "))
}
