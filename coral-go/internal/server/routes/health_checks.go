package routes

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/healthcheck"
)

// Custom health checks (#20176, design v2): the Orchestrator or the Operator adds, changes, pauses and removes a team's checks. Whatever is added or changed is pending: nothing runs until the Operator approves its record
// (the approval is the next slice). Pause, change and remove end the check's live run tokens at once. None of these routes is reachable through Coral Hub.

// CheckTokenRevoker ends a check's live run tokens.
type CheckTokenRevoker interface {
	RevokeCheckTokensFor(ctx context.Context, project, check string, now time.Time) error
}

// SetCheckTokens gives the check routes Coral's folder (the snapshots live under it) and the store of the run tokens.
func (h *BoardHandler) SetCheckTokens(coralDir string, t CheckTokenRevoker) {
	h.checkSnapDir = filepath.Join(coralDir, "checks", "snapshots")
	h.checkTokens = t
}

const (
	maxCheckArgs   = 20
	maxCheckArgLen = 500
)

// checkView is a check as the routes show it.
type checkView struct {
	board.HealthCheck
	RecordHash    string `json:"record_hash"`
	ApprovalWords string `json:"approval_words"`
}

func viewOf(c board.HealthCheck) checkView {
	return checkView{HealthCheck: c, RecordHash: c.RecordHash(), ApprovalWords: c.ApprovalWords()}
}

// checkAdmin is the caller's check: the team's orchestrator or the Operator, never through Coral Hub.
func (h *BoardHandler) checkAdmin(w http.ResponseWriter, r *http.Request) (project, who string, ok bool) {
	project = urlParam(r, "project")
	if cloud.Tunneled(r) {
		errForbidden(w, "a team's checks are managed on this computer, not through Coral Hub")
		return "", "", false
	}
	who, ok = h.healthAdmin(r, project)
	if !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can manage its checks")
		return "", "", false
	}
	return project, who, true
}

// boardMember is the member's own spelling of the name, or "" for the Operator, a stranger or an empty name: what is stored is never the request's spelling.
func (h *BoardHandler) boardMember(ctx context.Context, project, name string) string {
	if strings.TrimSpace(name) == "" || board.SameIdentity(name, board.OperatorName) {
		return ""
	}
	sub, err := h.bs.GetProjectSubscription(ctx, project, name)
	if err != nil || sub == nil {
		return ""
	}
	return sub.SubscriberID
}

type checkBody struct {
	Name     *string   `json:"name"`
	Script   *string   `json:"script"`
	Args     *[]string `json:"args"`
	Dir      *string   `json:"dir"`
	Every    *string   `json:"every"`
	Daily    *string   `json:"daily"`
	TZ       *string   `json:"tz"`
	To       *string   `json:"to"`
	ActsAs   *string   `json:"acts_as"`
	MayWrite *bool     `json:"may_write"`
}

// apply puts the fields that were sent on c and refuses what cannot be run or reaches a person it must not. why is the refusal in words.
func (h *BoardHandler) applyCheckBody(ctx context.Context, project string, b checkBody, c *board.HealthCheck) (why string) {
	if b.Script != nil {
		src := *b.Script
		if !filepath.IsAbs(src) {
			return "script: give the script's full path"
		}
		if h.checkSnapDir == "" {
			return "checks are not set up on this Coral"
		}
		hash, path, err := healthcheck.Snapshot(src, h.checkSnapDir)
		if err != nil {
			return "script: " + err.Error()
		}
		c.ScriptSrc, c.ScriptHash, c.Snapshot = src, hash, path
	}
	if b.Args != nil {
		if len(*b.Args) > maxCheckArgs {
			return "args: at most 20 arguments"
		}
		for _, a := range *b.Args {
			if len(a) > maxCheckArgLen || strings.ContainsRune(a, 0) {
				return "args: each argument is at most 500 bytes, with no NUL"
			}
		}
		c.Args = append([]string{}, *b.Args...)
	}
	if b.Dir != nil {
		fi, err := os.Stat(*b.Dir)
		if !filepath.IsAbs(*b.Dir) || err != nil || !fi.IsDir() {
			return "dir: give the full path of a folder that exists"
		}
		c.Dir = *b.Dir
	}
	if b.Every != nil {
		c.Every = *b.Every
	}
	if b.Daily != nil {
		c.Daily = *b.Daily
	}
	if b.TZ != nil {
		c.TZ = *b.TZ
	}
	if b.MayWrite != nil {
		c.MayWrite = *b.MayWrite
	}
	if b.To != nil {
		c.To = ""
		if *b.To != "" {
			if c.To = h.boardMember(ctx, project, *b.To); c.To == "" {
				return "to: a member of this board, never the Operator (or leave it out for the Orchestrator)"
			}
		}
	}
	if b.ActsAs != nil {
		if c.ActsAs = h.boardMember(ctx, project, *b.ActsAs); c.ActsAs == "" {
			return "acts_as: a member of this board, never the Operator"
		}
	}
	return ""
}

func (h *BoardHandler) revokeCheck(ctx context.Context, project, name string) error {
	if h.checkTokens == nil {
		return nil
	}
	return h.checkTokens.RevokeCheckTokensFor(ctx, project, name, time.Now())
}

var errRefusedChange = errors.New("change refused")

func checkErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, board.ErrCheckMissing):
		errNotFound(w, err.Error())
	case errors.Is(err, board.ErrCheckExists), errors.Is(err, board.ErrCheckLimit):
		writeError(w, http.StatusConflict, "check_conflict", err.Error())
	default:
		errBadRequest(w, err.Error())
	}
}

// ListHealthChecksRoute answers GET /api/board/{project}/health/checks.
func (h *BoardHandler) ListHealthChecksRoute(w http.ResponseWriter, r *http.Request) {
	project, _, ok := h.checkAdmin(w, r)
	if !ok {
		return
	}
	cs, err := h.bs.ListHealthChecks(r.Context(), project)
	if err != nil {
		errInternalServer(w, "could not read the checks")
		return
	}
	out := make([]checkView, 0, len(cs))
	for _, c := range cs {
		out = append(out, viewOf(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"checks": out})
}

// AddHealthCheckRoute answers POST /api/board/{project}/health/checks: the check is stored pending.
func (h *BoardHandler) AddHealthCheckRoute(w http.ResponseWriter, r *http.Request) {
	project, who, ok := h.checkAdmin(w, r)
	if !ok {
		return
	}
	var b checkBody
	if err := decodeJSON(r, &b); err != nil || b.Name == nil || b.Script == nil || b.Dir == nil {
		errBadRequest(w, "name, script (its full path) and dir are required")
		return
	}
	c := board.HealthCheck{Project: project, Name: *b.Name, Args: []string{}}
	if b.ActsAs == nil && who != "Operator" {
		b.ActsAs = &who // the check speaks as the member who added it unless it is told otherwise
	}
	if b.ActsAs == nil {
		errBadRequest(w, "acts_as: the member this check speaks as")
		return
	}
	if why := h.applyCheckBody(r.Context(), project, b, &c); why != "" {
		errBadRequest(w, why)
		return
	}
	c, err := h.bs.AddHealthCheck(r.Context(), c, time.Now())
	if err != nil {
		checkErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewOf(c))
}

// ChangeHealthCheckRoute answers PUT /api/board/{project}/health/checks/{name}: only the fields sent change; if the record changed the check is pending again, and its live tokens end.
func (h *BoardHandler) ChangeHealthCheckRoute(w http.ResponseWriter, r *http.Request) {
	project, _, ok := h.checkAdmin(w, r)
	if !ok {
		return
	}
	name := urlParam(r, "name")
	var b checkBody
	if err := decodeJSON(r, &b); err != nil || b.Name != nil {
		errBadRequest(w, "send the fields to change (a check's name cannot change)")
		return
	}
	before, err := h.bs.GetHealthCheck(r.Context(), project, name)
	if err != nil {
		checkErr(w, err)
		return
	}
	var why string
	c, err := h.bs.ChangeHealthCheckOrRefuse(r.Context(), project, name, func(c *board.HealthCheck) error {
		if why = h.applyCheckBody(r.Context(), project, b, c); why != "" {
			return errRefusedChange
		}
		return nil
	})
	if why != "" {
		errBadRequest(w, why)
		return
	}
	if err != nil {
		checkErr(w, err)
		return
	}
	if c.RecordHash() != before.RecordHash() { // whenever the stored record changed, a run that began under the old approval ends with it
		if err := h.revokeCheck(r.Context(), project, name); err != nil {
			errInternalServer(w, "the check changed, but its live tokens could not be ended")
			return
		}
	}
	writeJSON(w, http.StatusOK, viewOf(c))
}

// PauseHealthCheckRoute answers POST /api/board/{project}/health/checks/{name}/pause {"paused": bool}: a resumed check is approved again only if its record is still the approved one.
func (h *BoardHandler) PauseHealthCheckRoute(w http.ResponseWriter, r *http.Request) {
	project, _, ok := h.checkAdmin(w, r)
	if !ok {
		return
	}
	name := urlParam(r, "name")
	var b struct {
		Paused *bool `json:"paused"`
	}
	if err := decodeJSON(r, &b); err != nil || b.Paused == nil {
		errBadRequest(w, `paused: true or false`)
		return
	}
	if err := h.bs.PauseHealthCheck(r.Context(), project, name, *b.Paused, time.Now()); err != nil {
		checkErr(w, err)
		return
	}
	if *b.Paused {
		if err := h.revokeCheck(r.Context(), project, name); err != nil {
			errInternalServer(w, "the check is paused, but its live tokens could not be ended")
			return
		}
	}
	c, err := h.bs.GetHealthCheck(r.Context(), project, name)
	if err != nil {
		checkErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewOf(c))
}

// RemoveHealthCheckRoute answers DELETE /api/board/{project}/health/checks/{name}.
func (h *BoardHandler) RemoveHealthCheckRoute(w http.ResponseWriter, r *http.Request) {
	project, _, ok := h.checkAdmin(w, r)
	if !ok {
		return
	}
	name := urlParam(r, "name")
	if err := h.bs.RemoveHealthCheck(r.Context(), project, name); err != nil {
		checkErr(w, err)
		return
	}
	if err := h.revokeCheck(r.Context(), project, name); err != nil {
		errInternalServer(w, "the check is removed, but its live tokens could not be ended")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
