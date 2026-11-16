// Starting an agent CLI's own sign-in flow from the Settings UI (#15848 group 3, task #16714). Security review: this route starts a process on the local
// machine that opens a browser for OAuth; it runs only for the Operator on this computer (never through the Hub, never for an agent token), with a fixed
// argument list per agent type (no caller input reaches the command line), rate-limited to one start per agent type per signinStartGap.

package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/internal/agentsignin"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/safego"
)

// signinLoginArgs are the fixed arguments each supported agent type's CLI takes to start its interactive login. Only agent types with a known
// non-destructive login command are listed; an unlisted type gets "not supported" instead of a process.
var signinLoginArgs = map[string][]string{
	"claude": {"auth", "login"},
}

// signinTerminalTypes sign in through a terminal the person sees, because their login asks questions (OpenCode's `auth login` picks a provider, #16716): the server builds the command from its own
// fixed shape (agent.OpencodeLoginCommand with Coral's own XDG folder) and types it into a plain Coral terminal; nothing the caller sends reaches it.
var signinTerminalTypes = map[string]bool{"opencode": true}

// signinStartGap is how often the same agent type's login may be started: once per gap, so a double-click or a script does not open two browsers.
const signinStartGap = 10 * time.Second

var (
	signinStartMu  sync.Mutex
	signinStartAt  = map[string]time.Time{}
	signinStartNow = time.Now
)

func claimSigninStart(agentType string) bool {
	signinStartMu.Lock()
	defer signinStartMu.Unlock()
	now := signinStartNow()
	if last, ok := signinStartAt[agentType]; ok && now.Sub(last) < signinStartGap {
		return false
	}
	signinStartAt[agentType] = now
	return true
}

// CLISignIn starts the agent CLI's own interactive sign-in on this computer.
// POST /api/system/cli-signin?type=claude
func (h *SystemHandler) CLISignIn(w http.ResponseWriter, r *http.Request) {
	agentType := r.URL.Query().Get("type")
	if agentType == "" {
		errBadRequest(w, "type parameter required")
		return
	}
	if cloud.Tunneled(r) || !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "local_only", "sign-in can only be started from this computer's dashboard")
		return
	}
	if signinTerminalTypes[agentType] {
		h.signinInTerminal(w, r, agentType)
		return
	}
	args, ok := signinLoginArgs[agentType]
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "not_supported", "message": agentType + " does not have a supported sign-in command"})
		return
	}
	if !claimSigninStart(agentType) {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "too_soon", "message": "sign-in was started a moment ago; complete it in the browser that opened, then Check"})
		return
	}
	settings, err := h.ss.GetSettingsForCLI(r.Context())
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "error", "message": "could not read settings"})
		return
	}
	bin, err := agent.FindCLI(settings, agentType)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "cli_not_found", "message": "the " + agentType + " CLI was not found; install it first"})
		return
	}

	cmd := executil.Command(context.Background(), bin, args...)
	cmd.Stdin = nil
	cmd.Dir = os.TempDir()
	cmd.Env = agent.CLIEnv(agentenv.Filter(os.Environ()), bin)
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "error", "message": "could not start the sign-in command"})
		return
	}
	safego.Go("routes:cliSigninWait", func() { _ = cmd.Wait() })
	agentsignin.Forget(agentType, bin)
	writeJSON(w, http.StatusOK, map[string]any{"started": true})
}

// signinInTerminal opens a Coral terminal that runs the type's login command (#16716). The folder is Coral's own, private one for that CLI; the command is built here.
func (h *SystemHandler) signinInTerminal(w http.ResponseWriter, r *http.Request, agentType string) {
	if h.signinTerminal == nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "error", "message": "a terminal can't be opened here"})
		return
	}
	if !claimSigninStart(agentType) {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "too_soon", "message": "sign-in was started a moment ago; use the terminal that opened, then Check"})
		return
	}
	settings, err := h.ss.GetSettingsForCLI(r.Context())
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "error", "message": "could not read settings"})
		return
	}
	bin, err := agent.FindCLI(settings, agentType)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "cli_not_found", "message": "the " + agentType + " CLI was not found; install it first"})
		return
	}
	dir := filepath.Join(h.cfg.CoralDir(), agentType)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "error", "message": "could not make the sign-in folder"})
		return
	}
	command := agent.OpencodeLoginCommand(bin, opencode.XDGVars(dir))
	reply, err := h.signinTerminal(r.Context(), dir, command)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"started": false, "reason": "error", "message": "could not open the terminal"})
		return
	}
	agentsignin.Forget(agentType, bin)
	writeJSON(w, http.StatusOK, map[string]any{"started": true, "terminal": true, "session_name": reply["session_name"], "session_id": reply["session_id"]})
}
