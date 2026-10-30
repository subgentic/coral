package startup

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11122: every agent CLI that writes a conversation Coral can read is scanned by the History indexer. Pi's scanner existed and was not in the list the server starts the indexer with, so a Pi agent's chat
// never reached History (no row, no summary, no search); the unit tests that call the scanner directly could not see it.
func TestTheIndexerScansEveryCLIWithHistory(t *testing.T) {
	var types []string
	for _, s := range historyScanners() {
		if a, ok := s.(agent.Agent); ok {
			types = append(types, a.AgentType())
		}
	}
	assert.ElementsMatch(t, []string{at.Claude, at.Agy, at.Codex, at.Pi}, types)
}
