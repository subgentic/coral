package routes

import (
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
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
		Thinking       string              `json:"thinking"`
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
	// The program the launch would run: the configured CLI path, screened as a launch screens it. Without it a preview of agy would ask whatever "agy" is on the PATH for its --help (agy reads its own help
	// to know if --mode takes auto), where the launch asks the configured file: the preview must read the same one (#15735, caught by the browser harness's real-CLI guard, #4354).
	cliPath := ""
	if h.ss != nil {
		if st, serr := h.launchSettings(r.Context()); serr == nil {
			if p, perr := resolveLaunchCLIScreened(body.AgentType, agent.ResolveCLIPath(st, body.AgentType), h.commonPlaceScreen(r.Context())); perr == nil {
				cliPath = p
			}
		}
	}
	if !agentmodels.ValidThinking(body.AgentType, body.Thinking) {
		errBadRequest(w, errInvalidThinking(body.AgentType))
		return
	}
	if body.Thinking != "" { // the level is the CLI's one --effort, as the launch puts it
		body.Flags = append(agentmodels.StripThinkingFlags(body.Flags), agentmodels.ThinkingArgs(body.AgentType, body.Thinking)...)
	}
	params := agent.LaunchParams{PermissionMode: body.PermissionMode, Flags: body.Flags, CLIPath: cliPath, KeepFullAccess: body.KeepFullAccess, Capabilities: body.Capabilities}
	customNote := h.resolveCustomMode(r.Context(), body.AgentType, &params) // a custom mode adds its own flags, as every launch path does (#15950)
	args, err := agent.LaunchPermissionArgs(body.AgentType, params)
	if err != nil {
		errBadRequest(w, "that choice cannot be launched: "+err.Error())
		return
	}
	if args == nil {
		args = []string{}
	}
	// note: why the flags differ from the pick, for Codex (#15735): Full access kept, a capability set that narrows the mode (#6425) or sets the flags for a Default pick (#6422); and, when no flags are added at
	// all, that Codex's own settings decide. "" for every other agent and when the pick's own flags are what runs.
	note := ""
	if body.AgentType == "codex" {
		note = agent.CodexModeNote(body.Capabilities, body.PermissionMode, body.KeepFullAccess)
		if note == "" {
			note = agent.CodexAutoNote(args, body.Flags, body.PermissionMode, body.KeepFullAccess)
		}
		if note == "" && len(args) == 0 {
			note = "No permission flags are added, so Codex's own settings (its config file) decide."
		}
	}
	if note == "" {
		note = customNote
	}
	// command: the agent's whole start command, read off the same builder (#15951), with what Coral makes up for the session as <placeholders>. "" when this agent has none to show.
	command, cerr := agent.LaunchCommandPreview(body.AgentType, params)
	if cerr != nil {
		command = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{"args": args, "text": strings.Join(args, " "), "note": note, "command": command})
}
