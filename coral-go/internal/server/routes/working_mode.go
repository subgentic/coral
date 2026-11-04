package routes

import (
	"context"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"net/http"
)

func (h *BoardHandler) GetWorkingMode(w http.ResponseWriter, r *http.Request) {
	mode, err := h.bs.GetWorkingMode(r.Context(), urlParam(r, "project"))
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, mode)
}
func (h *BoardHandler) SetWorkingMode(w http.ResponseWriter, r *http.Request) {
	var mode board.WorkingMode
	if err := decodeJSON(r, &mode); err != nil {
		errBadRequest(w, "invalid working mode JSON")
		return
	}
	if refuseGuestNewBoard(w, r, h.bs, urlParam(r, "project")) {
		return
	}
	priorMode, _ := h.bs.GetWorkingMode(r.Context(), urlParam(r, "project")) // what the Orchestrator is told changed (#13173)
	result, err := h.bs.SetWorkingMode(r.Context(), urlParam(r, "project"), mode)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	noteSettingsChange(h.bs, r, urlParam(r, "project"), workingModeShown(priorMode), workingModeShown(result))
	writeJSON(w, http.StatusOK, result)
}

// Presets are team guidance editable by users and agents, not task assignments.
func (h *BoardHandler) ListWorkflowPresets(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	presets, err := h.bs.ListWorkflowPresets(r.Context(), project)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	mode, err := h.bs.GetWorkingMode(r.Context(), project)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"presets": presets, "working_mode": mode})
}
func (h *BoardHandler) SaveWorkflowPreset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Instructions string `json:"instructions"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid preset JSON")
		return
	}
	if refuseGuestNewBoard(w, r, h.bs, urlParam(r, "project")) {
		return
	}
	create := r.Method == http.MethodPost
	id := chi.URLParam(r, "presetID")
	if create {
		id = body.ID
	}
	priorPreset := h.presetBefore(r.Context(), urlParam(r, "project"), id)
	p, err := h.bs.SaveWorkflowPreset(r.Context(), urlParam(r, "project"), id, body.Name, body.Instructions, create)
	if err != nil {
		if errors.Is(err, board.ErrPresetExists) {
			errConflict(w, err.Error())
		} else {
			errBadRequest(w, err.Error())
		}
		return
	}
	noteSettingsChange(h.bs, r, urlParam(r, "project"), priorPreset, presetShown(p))
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	writeJSON(w, status, p)
}
func (h *BoardHandler) ResetWorkflowPreset(w http.ResponseWriter, r *http.Request) {
	priorPreset := h.presetBefore(r.Context(), urlParam(r, "project"), chi.URLParam(r, "presetID"))
	p, err := h.bs.ResetWorkflowPreset(r.Context(), urlParam(r, "project"), chi.URLParam(r, "presetID"))
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	noteSettingsChange(h.bs, r, urlParam(r, "project"), priorPreset, presetShown(p))
	writeJSON(w, http.StatusOK, p)
}

// workingModeShown is a working mode as the settings notice compares it: the choices, not the instruction text built from them.
func workingModeShown(m board.WorkingMode) map[string]any {
	return map[string]any{"working_mode.mode": m.Mode, "working_mode.dependency_guidance": m.DependencyGuidance, "working_mode.asks_are_tasks": m.AsksAreTasks, "working_mode.custom_instructions": m.CustomInstructions}
}

// presetShown is a workflow preset as the settings notice compares it: its name and instructions.
func presetShown(p board.WorkflowPreset) map[string]any {
	return map[string]any{"workflow_preset." + p.ID + ".name": p.Name, "workflow_preset." + p.ID + ".instructions": p.Instructions}
}

// presetBefore is the preset id as it is now (nothing when it does not exist yet: a create).
func (h *BoardHandler) presetBefore(ctx context.Context, project, id string) map[string]any {
	presets, err := h.bs.ListWorkflowPresets(ctx, project)
	if err != nil {
		return nil
	}
	for _, p := range presets {
		if p.ID == id {
			return presetShown(p)
		}
	}
	return nil
}
