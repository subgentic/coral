package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #15114: a restart keeps the agent's model when none is given. A Codex agent restarted with no model came back on its default (gpt-6-luna), not the gpt-6.1-sol it ran: its model was on its stored command
// line (--model), not in the row's model column, and the restart strips the stored model flag and put back only the column's.
func TestARestartKeepsTheModelThatWasOnTheStoredCommandLine(t *testing.T) {
	ls := &store.LiveSession{SessionID: "s1", AgentType: at.Codex, Flags: store.MarshalFlags([]string{"--model", "gpt-6.1-sol", "--full-auto"})}
	p := &restartPlan{agentType: at.Codex, stored: ls}
	p.restartSettings()
	assert.Equal(t, "gpt-6.1-sol", p.model, "the model of the stored command line is the one it restarts with")
	assert.Contains(t, p.flags, "gpt-6.1-sol")

	// the other spellings
	for _, flags := range [][]string{{"-m", "gpt-6.1-sol"}, {"--model=gpt-6.1-sol"}} {
		p = &restartPlan{agentType: at.Codex, stored: &store.LiveSession{SessionID: "s1", AgentType: at.Codex, Flags: store.MarshalFlags(flags)}}
		p.restartSettings()
		assert.Equal(t, "gpt-6.1-sol", p.model, "%v", flags)
	}
}

func TestARestartThatNamesAModelOrAnotherProviderDoesNotTakeTheStoredFlagsModel(t *testing.T) {
	flags := store.MarshalFlags([]string{"--model", "gpt-6.1-sol"})
	// the column wins over the command line
	m := "gpt-6-luna"
	p := &restartPlan{agentType: at.Codex, stored: &store.LiveSession{SessionID: "s1", AgentType: at.Codex, Model: &m, Flags: flags}}
	p.restartSettings()
	assert.Equal(t, "gpt-6-luna", p.model)
	// a request that clears the model (an empty one) asks for the default
	empty := ""
	p = &restartPlan{agentType: at.Codex, req: restartRequest{Model: &empty}, stored: &store.LiveSession{SessionID: "s1", AgentType: at.Codex, Flags: flags}}
	p.restartSettings()
	assert.Equal(t, "", p.model, "an explicit empty model clears it")
	// a switch to another provider: the stored flags do not carry
	p = &restartPlan{agentType: at.Claude, stored: &store.LiveSession{SessionID: "s1", AgentType: at.Codex, Flags: flags}}
	p.restartSettings()
	assert.Equal(t, "", p.model, "another provider's model is not carried")
}
