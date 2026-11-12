package routes

import (
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/agent"
)

// PostLaunchPermissionArgs is POST /api/launch/permission-args {agent_type, permission_mode, flags, keep_full_access, capabilities} (#15719): the permission arguments a launch with that choice would
// add to the agent's command line, from the same builders the launch runs (agent.LaunchPermissionArgs), for the New agent dialog to show. It starts nothing and writes nothing.
func (h *SessionsHandler) PostLaunchPermissionArgs(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AgentType      string              `json:"agent_type"`
		PermissionMode string              `json:"permission_mode"`
		Flags          []string            `json:"flags"`
		KeepFullAccess bool                `json:"keep_full_access"`
		Capabilities   *agent.Capabilities `json:"capabilities"`
	}
	if err := decodeJSONLimit(r, &body, 16<<10); err != nil { // 16 KB: a choice of permissions is a few hundred bytes
		errBadRequest(w, "send agent_type, permission_mode, keep_full_access and capabilities as JSON")
		return
	}
	if len(body.AgentType) > 40 || len(body.PermissionMode) > 40 || len(body.Flags) > 40 {
		errBadRequest(w, "agent_type or permission_mode is too long")
		return
	}
	for _, f := range body.Flags {
		if len(f) > 200 {
			errBadRequest(w, "a flag is too long")
			return
		}
	}
	args, err := agent.LaunchPermissionArgs(body.AgentType, agent.LaunchParams{PermissionMode: body.PermissionMode, Flags: body.Flags, KeepFullAccess: body.KeepFullAccess, Capabilities: body.Capabilities})
	if err != nil {
		errBadRequest(w, "that choice cannot be launched: "+err.Error())
		return
	}
	if args == nil {
		args = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"args": args, "text": strings.Join(args, " ")})
}
