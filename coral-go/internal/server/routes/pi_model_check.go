package routes

import (
	"context"
	"errors"
	"strings"

	"github.com/subgentic/coral/internal/agentmodels"
)

// A Pi model given as provider/id is checked against what pi --list-models lists (#11105, row 16), so a launch on a name Pi cannot use is refused with the reason instead of Pi starting and failing in its own
// pane. What cannot be checked is let through: a list not fetched yet (asking starts the fetch), a bare id or a pattern (Pi matches those itself: "sonnet"), and a custom model the operator added for Pi.

// PiModelProblem is the sentence that says model is not one Pi lists, or "" when it is, or cannot be checked.
func (h *SystemHandler) PiModelProblem(ctx context.Context, model string) string {
	model = strings.TrimSpace(model)
	if i := strings.LastIndex(model, ":"); i > 0 && agentmodels.ValidThinking("pi", model[i+1:]) { // Pi's shorthand for a thinking level: provider/id:high
		model = model[:i]
	}
	if model == "" || !strings.Contains(model, "/") || h.models == nil {
		return ""
	}
	res := h.models.Get("pi")
	if res.Source != "account" || len(res.Models) == 0 { // the CLI's own list, once it has been read
		return ""
	}
	for _, m := range res.Models {
		if m.Value == model {
			return ""
		}
	}
	if custom, err := h.loadCustomModels(ctx); err != nil {
		return "" // the operator's custom models cannot be read: not a reason to refuse
	} else {
		for _, c := range custom {
			if c.Family == "pi" && c.Value == model {
				return ""
			}
		}
	}
	return "Pi has no model \"" + model + "\": the models it lists are in `pi --list-models` (Settings > Custom models adds one it does not list)"
}

// SetPiModelCheck gives the sessions handler the check (it lives with the models service on the system handler).
func (h *SessionsHandler) SetPiModelCheck(f func(ctx context.Context, model string) string) {
	h.piModelCheck = f
}

// checkAgentModel is validateAgentModel plus the Pi list check.
func (h *SessionsHandler) checkAgentModel(ctx context.Context, agentType, model string) error {
	if err := validateAgentModel(agentType, model); err != nil {
		return err
	}
	if agentType == "pi" && h.piModelCheck != nil {
		if msg := h.piModelCheck(ctx, model); msg != "" {
			return errors.New(msg)
		}
	}
	return nil
}
