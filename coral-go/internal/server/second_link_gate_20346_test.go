package server

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #20346, Security 1, #20444 and #20838: a second link is allowed only when no tunnel write is pending in the pair census and the tests that prove the pair rule (the same person label on two links shares nothing; the
// pair census; the per-link ask list) still exist. The open items (#20405, #20413) are closed, and the Operator decided a second link takes the first link's path, so the switch is on.
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
	if !store.SecondLinkOpen {
		return
	}
	// #20838: the switch is on only with the pair rule tested for one person label on two links; each of these must still exist (a test that is removed reopens the gate).
	for _, name := range []string{"TestTheSamePersonLabelOnTwoLinksSharesNoGrantOrStream", "TestTheSamePersonLabelOnTwoLinksLeavesTwoSeparateRows", "TestEveryTunnelWriteRouteRecordsThePairOrIsListedPending", "TestAnAddedHubAnswersOnlyTheAsksThePersonAllowed"} {
		found := false
		for _, f := range []string{"second_link_same_person_20838_test.go", "pair_census_test.go", "link_asks_20413_test.go"} {
			if b, err := os.ReadFile(f); err == nil && strings.Contains(string(b), "func "+name+"(") {
				found = true
			}
		}
		assert.True(t, found, "SecondLinkOpen is true but %s is gone: the second link needs it (Security, #20838)", name)
	}
}
