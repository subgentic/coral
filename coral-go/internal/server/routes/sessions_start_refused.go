package routes

import (
	"context"
	"errors"
	"log/slog"
	"runtime"
	"strings"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// A wake, restart or resume nobody is watching (after a Coral restart, a board wake) that is refused because the agent's CLI is missing used to leave a 422 in a log and a sleeping
// agent that looked like any other (#353). The agent is now marked "Failed to start" (sleep reason cli_missing), which the dashboard shows with the words below, and a line goes to its
// board once. Only a sleeping agent is marked: a restart of a running one that is refused leaves it running, as it always did.

// cliDisplayName is how a CLI is named to a person.
var cliDisplayName = map[string]string{"claude": "Claude", "codex": "Codex", "pi": "Pi", "agy": "Antigravity", "gemini": "Antigravity"}

// startRefusal is the reason code of a refused start (store.StartFailure...): ok is false for an error that is not a missing or unusable CLI.
func startRefusal(err error) (code string, ok bool) {
	var nf *agent.CLINotFoundError
	var um *agent.CLIUntrustedMountError
	var cp *agent.CLIPathError
	switch {
	case errors.As(err, &nf):
		return store.StartFailureCLIMissing, true
	case errors.As(err, &um):
		return store.StartFailureUntrustedMount, true
	case errors.As(err, &cp):
		return store.StartFailureCLIPath, true
	}
	return "", false
}

// startFailureSentence is the one fixed sentence set for a reason code, from the agent's type alone: the CLI's display name and its program's name, never a path, a setting's value or
// anything from the environment. The server puts it in the board line and in the live row (start_failure_text), and the page writes that text as it is (textContent), so the two cannot
// drift. It begins with "failed to start" so the page can put the agent's name before it.
func startFailureSentence(agentType, code string) string {
	name := cliDisplayName[agentType]
	prog := ""
	if info := agent.GetCLIInfo(agentType); info != nil && info.Binary != "" {
		prog = info.Binary
		if runtime.GOOS == "windows" && !strings.Contains(prog, ".") {
			prog += ".exe"
		}
	}
	fix := "Set its path in Settings > CLI paths."
	if name != "" && prog != "" {
		fix = "Set Settings > CLI paths > " + name + " to its " + prog + "."
	}
	cli := "agent's"
	if name != "" {
		cli = name
	}
	switch code {
	case store.StartFailureCLIMissing:
		return "failed to start: the " + cli + " CLI was not found. " + fix
	case store.StartFailureUntrustedMount:
		return "failed to start: Windows will not open the folder the " + cli + " CLI is in. " + fix
	case store.StartFailureCLIPath:
		return "failed to start: the " + cli + " CLI path in Settings > CLI paths can't be run. " + fix + " Or clear it."
	}
	return ""
}

// markStartRefused marks a sleeping agent whose start was refused for its CLI (the field start_failure, apart from the sleep reason: an agent Coral stopped still auto-wakes at the next start
// once the CLI is fixed), and posts one line to its board when it was not marked already (a retry of the same wake, or the next start's auto-wake while the CLI is still missing, adds no
// line). It changes nothing else: no relaunch, no kill, no setting, and nothing is typed into the terminal.
func (h *SessionsHandler) markStartRefused(ctx context.Context, ls *store.LiveSession, err error) {
	if ls == nil || h.ss == nil {
		return
	}
	code, ok := startRefusal(err)
	if !ok || ls.IsSleeping != 1 || ls.IsArchived == 1 {
		return
	}
	sentence := startFailureSentence(ls.AgentType, code)
	already := ptr.Value(ls.StartFailure) == code
	if serr := h.ss.SetStartFailure(ctx, ls.SessionID, code); serr != nil {
		slog.Warn("could not mark an agent whose start was refused", "session_id", ls.SessionID, "error", serr)
		return
	}
	if already || h.bs == nil || ptr.Value(ls.BoardName) == "" {
		return
	}
	title := h.noticeName(ctx, *ls)
	if title == "" {
		return
	}
	if _, perr := h.bs.PostSystemMessage(ctx, ptr.Value(ls.BoardName), board.CoralSender, "@"+title+" "+sentence, nil); perr != nil {
		slog.Warn("could not post an agent's refused start to its board", "session_id", ls.SessionID, "error", perr)
	}
}
