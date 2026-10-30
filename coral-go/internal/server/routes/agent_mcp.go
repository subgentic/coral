package routes

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/mcpview"
)

// mcpEnvSource is where an agent's CLI configuration lives: the person's home and CODEX_HOME (PI_CODING_AGENT_DIR for Pi; a test seam: tests give a temporary home and never read the real one).
var mcpEnvSource = func() mcpview.Env {
	home, _ := os.UserHomeDir()
	return mcpview.Env{Home: home, CodexHome: os.Getenv("CODEX_HOME"), PiDir: os.Getenv("PI_CODING_AGENT_DIR")}
}

// AgentMCPServers lists the MCP servers an agent has configured (#9769): name, transport and scope, read from its CLI's own configuration for its working folder, read-only. Coral does not configure
// or edit MCP servers (#3644); a server's command, arguments, environment, headers and URLs are never read into the answer. The Operator's on this computer (never an agent token, never through
// Coral Hub), and the live session's own agent type and folder decide what is read, not the request's.
// GET /api/sessions/live/{name}/mcp-servers?session_id=<id>
func (h *SessionsHandler) AgentMCPServers(w http.ResponseWriter, r *http.Request) {
	if refuseNonOperator(w, r, "read an agent's MCP servers") {
		return
	}
	name := chi.URLParam(r, "name")
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		_, sessionID = logparse.ParseSessionName(name)
	}
	if sessionID == "" {
		writeSessionIDRequired(w)
		return
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil {
		errInternalServer(w, "could not read the session")
		return
	}
	if ls == nil {
		errNotFound(w, "session not found")
		return
	}
	res := mcpview.List(mcpEnvSource(), ls.AgentType, ls.WorkingDir)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, res)
}
