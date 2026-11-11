package routes

import (
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/agentmodels"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// resumedRunWith is the model and thinking level a conversation last ran at, read from its transcript (#15293): a resume that names neither starts at them, so a team set to Sonnet is not
// put back on "CLI default" by the Resume dialog. Only Claude's transcript is read here, and only for a conversation whose id the type accepts; "" for either when the transcript names none or
// names a value the launch would refuse.
func (h *SessionsHandler) resumedRunWith(agentType, resumeID, workDir string) (model, thinking string) {
	if h.jsonl == nil || resumeID == "" || agentType != at.Claude {
		return "", ""
	}
	abs, _ := filepath.Abs(workDir)
	h.jsonl.ReadClaudeTurnEvent(resumeID, abs) // the reader follows the transcript to its end: the newest assistant entry's model and level
	model = strings.TrimSpace(h.jsonl.TranscriptModel(resumeID))
	if model != "" && !agentmodels.ValidModelValue(model) {
		model = ""
	}
	thinking = strings.TrimSpace(h.jsonl.TranscriptThinking(resumeID))
	if thinking != "" && !agentmodels.ValidThinking(agentType, thinking) {
		thinking = ""
	}
	return model, thinking
}
