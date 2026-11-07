package routes

import (
	"encoding/json"
	"net/http"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// permissionEffectiveField is the row key that says what mode an agent's launch really gives it next to the one the person chose (#14085): {chosen, effective, narrowed, why}. A role's capabilities can
// narrow a chosen Bypass (an agy Technical Writer launched with Bypass started in accept-edits), and nothing said so. It is the Operator's alone, like the other keys that say who runs with what
// (personTextFields, dropOwnerOnlyCodexFields): an agent's token and a Hub viewer never get it.
const permissionEffectiveField = "permission_effective"

const (
	whyNarrowed = "the capabilities this agent was given allow less than the mode that was chosen"
)

func agyModeLabel(word string) string {
	switch word {
	case "skip":
		return "Bypass permissions"
	case "accept-edits":
		return "Accept edits"
	case "plan":
		return "Plan (read-only)"
	}
	return "Asks first"
}

var agyModeRank = map[string]int{"default": 0, "plan": 1, "accept-edits": 2, "skip": 3}

// permissionEffective is the row key's value for a stored agent, from the launch builders' own steps: nil when there is nothing to say. Codex says it only when the launch would give less than
// what was chosen (the live chip of #14051 has the rest); agy always says what it was started with; Claude's capabilities add allow and deny rules and never lower a chosen mode, so it has none.
func permissionEffective(agentType string, flags, capabilities, mode *string, keep bool) map[string]any {
	switch agentType {
	case "codex":
		chosenSandbox, chosenApproval := codexLaunchPair(flags, nil, mode, false)
		sandbox, approval := codexLaunchPair(flags, capabilities, mode, keep)
		chosen, effective := codexModeLabel(chosenApproval, chosenSandbox), codexModeLabel(approval, sandbox)
		if chosen == "" || effective == "" || !codexNarrows(chosenSandbox, chosenApproval, sandbox, approval) {
			return nil
		}
		return map[string]any{"chosen": chosen, "effective": effective, "narrowed": true, "why": whyNarrowed}
	case "agy":
		chosenWord := agent.AgyLaunchMode(storedFlags(flags), nil, ptr.Value(mode), false)
		word := agent.AgyLaunchMode(storedFlags(flags), storedCaps(capabilities), ptr.Value(mode), keep)
		narrowed := agyModeRank[word] < agyModeRank[chosenWord]
		out := map[string]any{"chosen": agyModeLabel(chosenWord), "effective": agyModeLabel(word), "narrowed": narrowed}
		if narrowed {
			out["why"] = whyNarrowed
		}
		return out
	}
	return nil
}

// addPermissionFields gives every Claude, Codex and agy row the keep-Full-access key (a boolean, always there for those three so the dashboard can show either state) and, when there is
// something to say, permission_effective. Both are the Operator's: dropOwnerOnlyCodexFields removes them for anyone else.
func addPermissionFields(rows []map[string]any, extras map[string]liveExtra) {
	for _, row := range rows {
		sid, _ := row["session_id"].(string)
		agentType, _ := row["agent_type"].(string)
		if sid == "" || !keepFullAccessType(agentType) {
			continue
		}
		ex := extras[sid]
		row[keepFullAccessField] = ex.KeepFull
		var pe any // always there, null when there is nothing to say: the dashboard merges rows, so an omitted key would keep a note that no longer holds
		if v := permissionEffective(agentType, ex.Flags, ex.Capabilities, ex.PermissionMode, ex.KeepFull); v != nil {
			pe = v
		}
		row[permissionEffectiveField] = pe
	}
}

// dropOwnerOnlyPermissionFields is dropOwnerOnlyCodexFields for these rows' keys, for a request that is not the Operator's.
func dropOwnerOnlyPermissionFields(r *http.Request, rows []map[string]any) {
	dropOwnerOnlyCodexFields(r, rows)
}

func storedFlags(flags *string) []string { return store.UnmarshalFlags(flags) }

func storedCaps(capabilities *string) *agent.Capabilities {
	if capabilities == nil || *capabilities == "" {
		return nil
	}
	c := &agent.Capabilities{}
	if json.Unmarshal([]byte(*capabilities), c) != nil {
		return nil
	}
	return c
}
