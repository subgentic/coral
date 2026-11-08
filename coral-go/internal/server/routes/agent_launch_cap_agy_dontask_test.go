package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/agent"
)

// #14772: agy's Don't ask is Plan (--mode plan, read-only), which asks for everything: the cap table records it as such whatever capabilities say, and never widens it to agy's yolo.
func TestAgyDontAskIsPlanOnTheCapTableAndFullCapabilitiesNeverWidenIt(t *testing.T) {
	full := &agent.Capabilities{Allow: []string{agent.CapShell, agent.CapFileWrite}}
	for _, typ := range []string{"agy", "antigravity", "gemini"} {
		assert.Equal(t, rankAsks, modeRank(typ, "dontAsk"), typ)
		assert.Equal(t, rankAsks, effectiveRank(typ, "dontAsk", full, false), typ+": full capabilities narrow Don't ask, they never widen it")
		assert.Equal(t, rankAsks, effectiveRank(typ, "plan", full, false), typ)
	}
}
