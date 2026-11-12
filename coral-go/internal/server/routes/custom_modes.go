package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/subgentic/coral/internal/custommodes"
	"github.com/subgentic/coral/internal/store"
)

// Custom permission modes (#15950): the modes the operator adds in Settings > Custom permission modes, each a name, an agent type and the launch flags it passes in place of a built-in
// mode's. They are served beside the built-ins to every picker (GET /api/custom-modes), saved as a whole set (PUT), and a launch, restart, wake or team launch that names "custom:<id>" resolves
// the id here and passes its flags. The flags are checked by custommodes against an allowlist when saved, when read and when a launch builds its argv.

const maxCustomModesBody = 64 << 10

type customModesReply struct {
	Modes  []customModeOut  `json:"modes"`
	Limits customModeLimits `json:"limits"`
}

type customModeOut struct {
	custommodes.Mode
	Risky bool `json:"risky"` // its flags turn the permission prompts off: the amber line and the 'Safety checks turned off' list name it
}

type customModeLimits struct {
	Types        []string            `json:"types"`
	MaxModes     int                 `json:"max_modes"`
	MaxFlags     int                 `json:"max_flags"`
	MaxNameLen   int                 `json:"max_name_length"`
	MaxTokenLen  int                 `json:"max_flag_length"`
	FlagRule     string              `json:"flag_rule"`
	AllowedFlags map[string][]string `json:"allowed_flags"` // per agent type, what a mode may carry (the form's hint)
}

func customModeLimitsNow() customModeLimits {
	return customModeLimits{
		Types: custommodes.Types(), MaxModes: custommodes.MaxModes, MaxFlags: custommodes.MaxFlags, MaxNameLen: custommodes.MaxNameLen, MaxTokenLen: custommodes.MaxTokens,
		FlagRule:     "one flag or value per line, from the list for the agent type; no spaces, quotes or paths",
		AllowedFlags: custommodes.Describe(),
	}
}

// loadCustomModes is the stored set, each row checked again: one that no longer passes is not served.
func (h *SystemHandler) loadCustomModes(ctx context.Context) ([]custommodes.Mode, error) {
	return loadCustomModesFrom(ctx, h.ss)
}

func loadCustomModesFrom(ctx context.Context, ss *store.SessionStore) ([]custommodes.Mode, error) {
	if ss == nil {
		return []custommodes.Mode{}, nil
	}
	rows, err := ss.ListCustomModes(ctx)
	if err != nil {
		return nil, err
	}
	in := make([]custommodes.Mode, 0, len(rows))
	for _, r := range rows {
		in = append(in, custommodes.Mode{ID: r.ID, AgentType: r.AgentType, Name: r.Name, Flags: r.Flags})
	}
	return custommodes.Clean(in), nil
}

func customModesOut(in []custommodes.Mode) []customModeOut {
	out := make([]customModeOut, 0, len(in))
	for _, m := range in {
		out = append(out, customModeOut{Mode: m, Risky: custommodes.Bypass(m.AgentType, m.Flags)})
	}
	return out
}

// GetCustomModes lists the custom modes and the limits Settings validates against. GET /api/custom-modes
func (h *SystemHandler) GetCustomModes(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone
		return
	}
	modes, err := h.loadCustomModes(r.Context())
	if err != nil {
		errInternalServer(w, "the custom modes could not be read")
		return
	}
	writeJSON(w, http.StatusOK, customModesReply{Modes: customModesOut(modes), Limits: customModeLimitsNow()})
}

// PutCustomModes replaces the whole set, as the custom models' does: the body is {"modes": [...]} and nothing else (a typo cannot clear the set), the list is validated as a whole, and a problem
// names the row and the field with nothing changed. A new row has no id: Coral makes one. PUT /api/custom-modes
func (h *SystemHandler) PutCustomModes(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	var raw map[string]json.RawMessage
	if err := decodeJSONMax(w, r, &raw, maxCustomModesBody); err != nil {
		errBadRequest(w, "invalid JSON, or more than 64 KiB")
		return
	}
	var modes []custommodes.Mode
	list, ok := raw["modes"]
	if !ok || len(raw) != 1 || string(bytes.TrimSpace(list)) == "null" || json.Unmarshal(list, &modes) != nil {
		errBadRequest(w, `the body is {"modes": [...]}: "modes" is a required list (empty to clear) and the only field`)
		return
	}
	// A kept row keeps its id only if it is one this computer already has: an id from nowhere is never accepted (a launch names ids).
	have := map[string]bool{}
	if cur, err := h.loadCustomModes(r.Context()); err == nil {
		for _, m := range cur {
			have[m.ID] = true
		}
	}
	for i := range modes {
		if modes[i].ID != "" && !have[modes[i].ID] {
			modes[i].ID = ""
		}
	}
	clean, err := custommodes.ValidateSet(modes, func() string { return strings.ReplaceAll(uuid.New().String(), "-", "")[:16] })
	var ce *custommodes.Error
	if errors.As(err, &ce) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": ce.Error(), "row": ce.Row, "field": ce.Field, "message": ce.Msg})
		return
	}
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	rows := make([]store.CustomMode, 0, len(clean))
	bypass := 0
	for _, c := range clean {
		rows = append(rows, store.CustomMode{ID: c.ID, AgentType: c.AgentType, Name: c.Name, Flags: c.Flags})
		if custommodes.Bypass(c.AgentType, c.Flags) {
			bypass++
		}
	}
	if h.ss == nil {
		errInternalServer(w, "the custom modes could not be saved")
		return
	}
	if err := h.ss.ReplaceCustomModes(r.Context(), rows, bypass); err != nil {
		errInternalServer(w, "the custom modes could not be saved")
		return
	}
	writeJSON(w, http.StatusOK, customModesReply{Modes: customModesOut(clean), Limits: customModeLimitsNow()})
}

// customModeFlags resolves "custom:<id>" for a launch of agentType (#15950): the flags it adds, checked again here (a row edited in the database never reaches a launch), or nil and a
// note for the person when the mode is gone, belongs to another agent type or no longer passes: the launch then goes on as Default, never fails ("never break on upgrade").
func (h *SessionsHandler) customModeFlags(ctx context.Context, agentType, mode string) (flags []string, note string) {
	id, ok := custommodes.IDOf(mode)
	if !ok {
		return nil, ""
	}
	modes, err := loadCustomModesFrom(ctx, h.ss)
	if err != nil {
		return nil, "the custom permission mode could not be read, so this agent started in Default"
	}
	for _, m := range modes {
		if m.ID != id {
			continue
		}
		if custommodes.Family(m.AgentType) != custommodes.Family(agentType) {
			return nil, "the custom permission mode \"" + m.Name + "\" is for another kind of agent, so this one started in Default"
		}
		if custommodes.ValidateFlags(agentType, m.Flags) != nil {
			return nil, "the custom permission mode \"" + m.Name + "\" no longer passes its checks, so this agent started in Default"
		}
		return append([]string{}, m.Flags...), ""
	}
	return nil, "the custom permission mode was deleted, so this agent started in Default"
}
