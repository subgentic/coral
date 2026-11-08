package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/agent"
)

// #14741: agy has its own auto mode (--mode auto), so on the cap's one scale it is rank 2 (judged), like Claude's Auto: more than accept edits, less than nothing asking. Full capabilities named with an auto
// mode narrow it and never widen it to agy's yolo (rank 3); with NO mode named they are still the rank, as before.
func TestAgyAutoIsJudgedAndFullCapabilitiesNeverWidenIt(t *testing.T) {
	full := &agent.Capabilities{Allow: []string{agent.CapShell, agent.CapFileWrite}}
	for _, typ := range []string{"agy", "antigravity", "gemini"} {
		assert.Equal(t, rankJudged, modeRank(typ, "auto"), typ)
		assert.Equal(t, rankOpen, modeRank(typ, "bypassPermissions"), typ)
		assert.Equal(t, rankJudged, effectiveRank(typ, "auto", full, false), typ+": a named auto is not widened by full capabilities")
		assert.Equal(t, rankOpen, effectiveRank(typ, "", full, false), typ+": no mode named, full capabilities are agy's yolo as before")
		assert.Equal(t, rankOpen, effectiveRank(typ, "auto", nil, true), typ+": Keep Full access is the top")
		mode, ok := modeForRank(typ, rankJudged)
		assert.True(t, ok, typ)
		assert.Equal(t, "auto", mode, typ+": the strongest mode at most judged")
		mode, _ = modeForRank(typ, rankEdits)
		assert.Equal(t, "acceptEdits", mode, typ)
	}
}
