package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #19633: no bare "@ " when the orchestrator has no name, and no tag for the orchestrator's own act.
func TestOrchestratorTagIsNeverBareAndNeverForTheOrchestratorsOwnAct(t *testing.T) {
	assert.Equal(t, "", orchestratorTag(""), "no orchestrator name: no tag, not a bare '@ '")
	assert.Equal(t, "", orchestratorTag("", "Dev"))
	assert.Equal(t, "@Orchestrator ", orchestratorTag("Orchestrator", "Dev"))
	assert.Equal(t, "", orchestratorTag("Orchestrator", "Orchestrator"), "its own release")
	assert.Equal(t, "", orchestratorTag("Orchestrator", "", "orchestrator"), "any of the named, by identity")
	assert.Equal(t, "@Orchestrator ", orchestratorTag("Orchestrator"))
}
