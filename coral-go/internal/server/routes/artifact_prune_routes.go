package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/cloud"
)

// isOperatorRequest is true for a person at this computer (the dashboard or the signed command line), false for an agent's token, a script and
// Coral Hub: what refuseNonOperator lets through, for a route that answers everyone but shows the Operator more (#4489).
func isOperatorRequest(r *http.Request) bool {
	return !cloud.Tunneled(r) && humanInputCaller(r)
}

func refuseNonOperator(w http.ResponseWriter, r *http.Request, what string) bool {
	if !isOperatorRequest(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only the Operator can "+what+", from this computer's dashboard or the signed command line")
		return true
	}
	return false
}

// pruneArtifactsRoute: POST /api/artifacts/prune {older_than_seconds, kinds, dry_run, shrink}.
// Operator only (a person: the dashboard or the signed command line), never through Coral Hub.
// dry_run defaults to true.
func (h *SessionsHandler) pruneArtifactsRoute(w http.ResponseWriter, r *http.Request) {
	if refuseNonOperator(w, r, "prune artifacts") {
		return
	}
	var body struct {
		OlderThanSeconds int64    `json:"older_than_seconds"`
		Kinds            []string `json:"kinds"`
		DryRun           *bool    `json:"dry_run"`
		Shrink           bool     `json:"shrink"`
	}
	if err := decodeJSONLimit(r, &body, 4096); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	o := pruneOptions{OlderThan: time.Duration(body.OlderThanSeconds) * time.Second, Kinds: map[string]bool{}, DryRun: body.DryRun == nil || *body.DryRun, Shrink: body.Shrink}
	if body.OlderThanSeconds < 0 {
		errBadRequest(w, "older_than_seconds must not be negative")
		return
	}
	if !o.Shrink && o.OlderThan < pruneMinOlderThan {
		errBadRequest(w, "a prune needs older_than_seconds of at least one day (86400)")
		return
	}
	if len(body.Kinds) == 0 {
		body.Kinds = []string{pruneKindDiffs}
	}
	for _, k := range body.Kinds {
		switch k {
		case pruneKindDiffs, pruneKindObjects, pruneKindDiffObjects:
			o.Kinds[k] = true
		case "all":
			o.Kinds[pruneKindDiffs], o.Kinds[pruneKindObjects], o.Kinds[pruneKindDiffObjects] = true, true, true
		default:
			errBadRequest(w, "kinds may be diffs, objects, diff-objects or all")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), pruneRunTimeout)
	defer cancel()
	rep, err := h.runPrune(ctx, o)
	switch {
	case errors.Is(err, errPruneBusy):
		writeError(w, http.StatusConflict, "prune_running", err.Error())
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "prune_failed", err.Error())
		return
	}
	if !o.DryRun {
		slog.Info("[artifacts] prune finished", "shrink", o.Shrink, "removed", rep.Removed, "freed", rep.Freed, "skipped", rep.Skipped, "errors", rep.Errors)
	}
	writeJSON(w, http.StatusOK, rep)
}

// keepArtifactRoute: PUT /api/artifacts/{id}/keep marks an artifact the Operator keeps (never
// pruned); DELETE removes the mark. Operator only.
func (h *SessionsHandler) keepArtifactRoute(w http.ResponseWriter, r *http.Request) {
	if refuseNonOperator(w, r, "keep or release an artifact") {
		return
	}
	id := chi.URLParam(r, "id")
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var err error
	if r.Method == http.MethodDelete {
		_, err = h.db.ExecContext(r.Context(), "DELETE FROM artifact_keep WHERE hex = ?", id)
	} else {
		if _, statErr := os.Stat(filepath.Join(h.cfg.CoralDir(), "artifacts", "objects", id)); statErr != nil {
			errNotFound(w, "artifact not found")
			return
		}
		_, err = h.db.ExecContext(r.Context(), "INSERT INTO artifact_keep (hex, kept_at) VALUES (?, ?) ON CONFLICT(hex) DO NOTHING", id, time.Now().UTC().Format(time.RFC3339))
	}
	if err != nil {
		errInternalServer(w, "could not update the keep mark")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "kept": r.Method != http.MethodDelete})
}

// keptListRoute: GET /api/system/artifact-store/kept, the artifacts the Operator keeps (for the Keep toggle on
// this computer's dashboard; never through Coral Hub).
func (h *SessionsHandler) keptListRoute(w http.ResponseWriter, r *http.Request) {
	if refuseNonOperator(w, r, "list kept artifacts") {
		return
	}
	kept, err := h.keptArtifacts(r.Context())
	if err != nil {
		errInternalServer(w, "could not read kept artifacts")
		return
	}
	ids := make([]string, 0, len(kept))
	for id := range kept {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	writeJSON(w, http.StatusOK, map[string]any{"kept": ids})
}
