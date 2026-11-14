package routes

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
)

const maxJoinedInstructions = 300

// tellOrchestratorOfNewAgent posts a board notice to the team's Orchestrator when an agent is added to a team that is already running (#17305): the new agent's name, role and instructions, so the Orchestrator
// can give it work. An agent added to a team with no Orchestrator, the Orchestrator itself and a terminal tell nobody. The notice is Coral's own (a system message); the new agent's words are cleaned and defused.
func (h *SessionsHandler) tellOrchestratorOfNewAgent(ctx context.Context, boardName, displayName, agentType, prompt string) {
	if h.bs == nil || boardName == "" || agentType == "terminal" {
		return
	}
	role := naming.SubscriberID(displayName, agentType)
	if strings.Contains(strings.ToLower(role), "orchestrator") {
		return
	}
	orch, err := h.bs.TeamOrchestrator(ctx, boardName)
	if err != nil || orch == "" || orch == role {
		return
	}
	names := []string{orch}
	instr := ""
	if text := strings.TrimSpace(clitext.Clean(prompt)); text != "" {
		if r := []rune(text); len(r) > maxJoinedInstructions {
			text = string(r[:maxJoinedInstructions]) + "…"
		}
		instr = " Its instructions: " + board.DefuseMentions(text, names) + "."
	}
	content := fmt.Sprintf("@%s [Coral] %s (%s) was added to the team and has joined the board. It has no tasks yet.%s Assign it work, or say why it is not needed.", orch, board.DefuseMentions(clitext.Clean(role), names), agentType, instr)
	if _, err := h.bs.PostSystemDefusedMessage(ctx, boardName, board.CoralSender, content, nil); err != nil {
		slog.Warn("[launch] the Orchestrator was not told of a new agent", "board", boardName, "error", err)
	}
}
