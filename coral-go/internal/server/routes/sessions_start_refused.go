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

// startRefusal is the fixed sentence for a refused start, from the agent's type alone: the CLI's name and its program's name, never a path, a setting's value or anything from the
// environment. ok is false for an error that is not a missing or unusable CLI.
func startRefusal(agentType string, err error) (sentence string, ok bool) {
	var nf *agent.CLINotFoundError
	var um *agent.CLIUntrustedMountError
	var cp *agent.CLIPathError
	name := cliDisplayName[agentType]
	if name == "" {
		name = "The agent's"
	}
	prog := "its program"
	if info := agent.GetCLIInfo(agentType); info != nil && info.Binary != "" {
		prog = info.Binary
		if runtime.GOOS == "windows" && !strings.Contains(prog, ".") {
			prog += ".exe"
		}
	}
	fix := "Set Settings > CLI paths > " + strings.TrimPrefix(name, "The agent's") + " to " + prog + "."
	if name == "The agent's" {
		fix = "Set its path in Settings > CLI paths."
	}
	switch {
	case errors.As(err, &nf):
		return "failed to start: the " + name + " CLI was not found. " + fix, true
	case errors.As(err, &um):
		return "failed to start: Windows will not open the folder the " + name + " CLI is in. " + fix, true
	case errors.As(err, &cp):
		return "failed to start: the " + name + " CLI path in Settings > CLI paths can't be run. Fix it or clear it.", true
	}
	return "", false
}

// markStartRefused marks a sleeping agent whose start was refused for its CLI, and posts one line to its board when it was not marked already (a retry of the same wake adds no line).
// It changes nothing else: no relaunch, no kill, no setting, and nothing is typed into the terminal.
func (h *SessionsHandler) markStartRefused(ctx context.Context, ls *store.LiveSession, err error) {
	if ls == nil || h.ss == nil {
		return
	}
	sentence, ok := startRefusal(ls.AgentType, err)
	if !ok || ls.IsSleeping != 1 || ls.IsArchived == 1 {
		return
	}
	already := ptr.Value(ls.SleepReason) == store.SleepReasonCLIMissing
	if serr := h.ss.SetSessionSleepingFor(ctx, ls.SessionID, store.SleepReasonCLIMissing); serr != nil {
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
