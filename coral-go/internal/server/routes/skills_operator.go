package routes

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/skills"
	"github.com/subgentic/coral/internal/store"
)

// The Operator's side of the Skills Store (#12022, goal #191): the list of every skill, the approval view with every file in full, and the decisions. An agent has none of these routes: what it
// publishes waits here, and only a person at the dashboard approves, rejects or removes.

type skillRowView struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Version        int    `json:"version"`
	Digest         string `json:"digest"`
	Description    string `json:"description"`
	Status         string `json:"status"`
	HasScripts     bool   `json:"has_scripts"`
	NotReviewable  bool   `json:"not_reviewable"`
	ScriptsAcked   bool   `json:"scripts_acked"`
	PublisherKind  string `json:"publisher_kind"`
	PublisherAgent string `json:"publisher_agent"`
	PublisherTeam  string `json:"publisher_team"`
	FileCount      int    `json:"file_count"`
	CreatedAt      string `json:"created_at"`
	DecidedAt      string `json:"decided_at"`
}

func skillView(r store.SkillRow) skillRowView {
	return skillRowView{ID: r.ID, Name: r.Name, Version: r.Version, Digest: r.Digest, Description: r.Description, Status: r.Status, HasScripts: r.HasScripts, NotReviewable: r.NotReviewable,
		ScriptsAcked: r.ScriptsAcked, PublisherKind: r.PublisherKind, PublisherAgent: r.PublisherAgent, PublisherTeam: r.PublisherTeam, FileCount: len(r.Files()), CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt}
}

func validSkillID(id string) bool { return len(id) == 32 && strings.Trim(id, "0123456789abcdef") == "" }

// ListSkillsOperator: GET /api/skills[?status=pending|approved|rejected]. Every skill but the removed ones, newest first.
func (h *SkillsHandler) ListSkillsOperator(w http.ResponseWriter, r *http.Request) {
	if refuseUnlessOperator(w, r, "read the skills") {
		return
	}
	status := r.URL.Query().Get("status")
	switch status {
	case "", store.SkillPending, store.SkillApproved, store.SkillRejected:
	default:
		errBadRequest(w, "status is pending, approved or rejected")
		return
	}
	rows, err := h.ss.ListSkills(r.Context(), status)
	if err != nil {
		errInternalServer(w, "could not list the skills")
		return
	}
	out := make([]skillRowView, 0, len(rows))
	for _, x := range rows {
		out = append(out, skillView(x))
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"skills": out})
}

// GetSkillOperator: GET /api/skills/{id}. The approval view's data: the row, every file with its size, kind and SHA-256, the text of every file that can be shown as text, and what the scanner
// found in the scripts. A removed skill has only its tombstone.
func (h *SkillsHandler) GetSkillOperator(w http.ResponseWriter, r *http.Request) {
	if refuseUnlessOperator(w, r, "read a skill") {
		return
	}
	id := chi.URLParam(r, "id")
	if !validSkillID(id) {
		errNotFound(w, "no such skill")
		return
	}
	row, err := h.ss.GetSkill(r.Context(), id)
	if err != nil {
		errNotFound(w, "no such skill")
		return
	}
	out := map[string]any{"skill": skillView(*row)}
	w.Header().Set("Cache-Control", "no-store")
	if row.Status == store.SkillRemoved {
		writeJSON(w, http.StatusOK, out)
		return
	}
	data, err := h.readSkillZip(row.Digest)
	if err != nil {
		writeError(w, http.StatusConflict, "skill_unreadable", "the stored copy of this skill is missing or is not the one that was published")
		return
	}
	sk, err := skills.Parse(data)
	if err != nil {
		writeError(w, http.StatusConflict, "skill_unreadable", "the stored copy of this skill is no longer a valid skill")
		return
	}
	contents := make(map[string]string, len(sk.Content))
	for p, b := range sk.Content {
		contents[p] = string(b)
	}
	scan := skills.Scan(sk)
	out["files"], out["contents"], out["warnings"], out["hosts"] = sk.Files, contents, scan.Warnings, scan.Hosts
	writeJSON(w, http.StatusOK, out)
}

type skillDecision struct {
	Digest       string `json:"digest"`
	ScriptsAcked bool   `json:"scripts_acked"`
}

func skillDecisionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrSkillNotFound):
		errNotFound(w, "no such skill")
	case errors.Is(err, store.ErrSkillState):
		errConflict(w, "this skill is not waiting for a decision")
	case errors.Is(err, store.ErrSkillDigest):
		writeError(w, http.StatusConflict, "skill_changed", "this is not the skill that was reviewed: open it again")
	case errors.Is(err, store.ErrStarterSkill):
		writeError(w, http.StatusConflict, "starter_skill", "this is one of Coral's example skills: it stays")
	case errors.Is(err, store.ErrNeedScriptsAck):
		writeError(w, http.StatusConflict, "scripts_not_acknowledged", "review the scripts and files that cannot be shown as text, and confirm them first")
	default:
		errInternalServer(w, "could not record the decision")
	}
}

// ApproveSkill: POST /api/skills/{id}/approve {"digest": ..., "scripts_acked": true|false}. Only a person at the dashboard. The digest is the one the approval view showed: the stored bytes are read again, must be
// exactly that, and are what is indexed. A skill with scripts or files that cannot be shown as text needs scripts_acked, the second click.
func (h *SkillsHandler) ApproveSkill(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only a person at the dashboard approves a skill")
		return
	}
	id := chi.URLParam(r, "id")
	if !validSkillID(id) {
		errNotFound(w, "no such skill")
		return
	}
	var req skillDecision
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if err := decodeJSON(r, &req); err != nil {
		errBadRequest(w, "send {\"digest\": ..., \"scripts_acked\": ...}")
		return
	}
	row, err := h.ss.GetSkill(r.Context(), id)
	if err != nil {
		errNotFound(w, "no such skill")
		return
	}
	if row.Status != store.SkillPending {
		errConflict(w, "this skill is not waiting for a decision")
		return
	}
	data, err := h.readSkillZip(row.Digest)
	if err != nil {
		writeError(w, http.StatusConflict, "skill_unreadable", "the stored copy of this skill is missing or is not the one that was published")
		return
	}
	sk, err := skills.Parse(data)
	if err != nil {
		writeError(w, http.StatusConflict, "skill_unreadable", "the stored copy of this skill is no longer a valid skill")
		return
	}
	if err := h.ss.ApproveSkill(r.Context(), id, req.Digest, req.ScriptsAcked, sk); err != nil {
		skillDecisionError(w, err)
		return
	}
	h.record(r, board.ActSkillApprove, row, "")
	h.recordAcks(r, row, req.ScriptsAcked, "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// RejectSkill: POST /api/skills/{id}/reject. Only a person. The bytes are remembered, so an agent cannot publish them again.
func (h *SkillsHandler) RejectSkill(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only a person at the dashboard rejects a skill")
		return
	}
	id := chi.URLParam(r, "id")
	if !validSkillID(id) {
		errNotFound(w, "no such skill")
		return
	}
	row, _ := h.ss.GetSkill(r.Context(), id)
	if err := h.ss.RejectSkill(r.Context(), id); err != nil {
		skillDecisionError(w, err)
		return
	}
	if row != nil {
		h.record(r, board.ActSkillReject, row, "")
		h.releaseSkillZip(r, row.Digest)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// RemoveSkill: DELETE /api/skills/{id}. Only a person. The text and the search entry go and a tombstone stays, so an agent that pinned the skill is told it was removed.
func (h *SkillsHandler) RemoveSkill(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only a person at the dashboard removes a skill")
		return
	}
	id := chi.URLParam(r, "id")
	if !validSkillID(id) {
		errNotFound(w, "no such skill")
		return
	}
	row, _ := h.ss.GetSkill(r.Context(), id)
	if err := h.ss.RemoveSkill(r.Context(), id); err != nil {
		skillDecisionError(w, err)
		return
	}
	if row != nil {
		h.record(r, board.ActSkillRemove, row, "")
		h.releaseSkillZip(r, row.Digest)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// NeedsYouItems are the skills waiting for the Operator, one Needs you item each: who published it (the session's agent), the team, and the skill and its version as one cleaned line.
func (h *SkillsHandler) NeedsYouItems(ctx context.Context) ([]NeedsYouItem, error) {
	rows, err := h.ss.ListSkills(ctx, store.SkillPending)
	if err != nil {
		return nil, err
	}
	items := make([]NeedsYouItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, NeedsYouItem{Kind: "skill", From: needsYouLine(r.PublisherAgent), Line: needsYouLine("Skill to approve: " + r.Name + " version " + strconv.Itoa(r.Version)), Team: r.PublisherTeam, ID: "skill:" + r.ID, At: needsYouTime(r.CreatedAt)})
	}
	return items, nil
}

// recordAcks writes the Operator's acknowledgements next to the decision they came with: the second click on the scripts and files that cannot be shown as text (when the skill had any), and a file that looks like
// a key or token going in anyway (the note names the file, never the secret).
func (h *SkillsHandler) recordAcks(r *http.Request, row *store.SkillRow, scriptsAcked bool, secretFile string) {
	if row == nil {
		return
	}
	if scriptsAcked && (row.HasScripts || row.NotReviewable) {
		h.record(r, board.ActSkillScriptsAck, row, "the scripts and files that cannot be shown as text were reviewed")
	}
	if secretFile != "" {
		h.record(r, board.ActSkillSecretAck, row, skillFileName(secretFile))
	}
}
