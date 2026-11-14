// Starting an agent CLI's own sign-in flow from the Settings UI (#15848 group 3, task #16714). Security review: this route starts a process on the local
// machine that opens a browser for OAuth; it runs only for the Operator on this computer (never through the Hub, never for an agent token), with a fixed
// argument list per agent type (no caller input reaches the command line), rate-limited to one start per agent type per signinStartGap.

package routes

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/internal/agentsignin"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/executil"
)

// signinLoginArgs are the fixed arguments each supported agent type's CLI takes to start its interactive login. Only agent types with a known
// non-destructive login command are listed; an unlisted type gets "not supported" instead of a process.
var signinLoginArgs = map[string][]string{
	"claude": {"auth", "login"},
}

// signinStartGap is how often the same agent type's login may be started: once per gap, so a double-click or a script does not open two browsers.
const signinStartGap = 10 * time.Second

var (
	signinStartMu sync.Mutex
	signinStartAt = map[string]time.Time{}
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
	go cmd.Wait()
	agentsignin.Forget(agentType, bin)
	writeJSON(w, http.StatusOK, map[string]any{"started": true})
}
