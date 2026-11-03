package routes

import (
	"context"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// transcriptStartMode is the permission mode a Claude agent's chat started in, for a row that recorded no mode and whose flags name none (#12718: an agent from before modes were recorded, started with
// Bypass permissions, woke in the saved default, Auto, and stopped at prompts). Claude's transcript entries carry permissionMode, and the first one is the mode the chat was started in: what the person
// chose at launch, read through the indexer's record of the file (transcriptStart opens it without following a link and reads its first 256 KiB). "" when there is none to read: the row has a mode or
// a permission flag of its own (those win), another CLI (only Claude's transcript carries one), no indexed file, or a value that is no known mode. It is a hint of what was chosen, never a way to
// widen a row: a transcript that started in Default gives Default.
func (h *SessionsHandler) transcriptStartMode(ctx context.Context, ls *store.LiveSession, flags []string) string {
	if ls == nil || ls.AgentType != at.Claude || h.ss == nil {
		return ""
	}
	if ls.PermissionMode != nil && *ls.PermissionMode != "" {
		return ""
	}
	if carried, _ := agent.SplitPermissionFlags(flags); len(carried) > 0 {
		return ""
	}
	idx, err := h.ss.GetIndexedSession(ctx, ls.SessionID)
	if err != nil || idx == nil {
		return ""
	}
	_, mode := transcriptStart(idx.SourceFile)
	return startModeOf(mode)
}

// startModeOf is a transcript's permissionMode as a mode Coral may put on a command line: a known mode and nothing else. The word comes from a file the CLI wrote and goes into the launch line, so a value
// that is not one of the known modes (a junk word, a quote, a backtick, a newline) is no mode at all and the row starts in Default; PermissionModeForCLI passes any word through, so this is the check.
func startModeOf(mode string) string {
	if mode == "" || !agent.ValidPermissionMode(mode) {
		return ""
	}
	return agent.PermissionModeForCLI(at.Claude, mode)
}
