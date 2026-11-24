package routes

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// A reviewer's draft comments on a document (#21189, goal #310; the contract is the one agreed on #21185). A draft is private to the reviewer (the owner of this computer, through a Hub the linked owner), is on
// one exact version, and notifies no one: it lives in a table of its own, so no read of the published comments can return it. Document artifacts only: a goal, a diff and a time-anchored video keep today's flow.
// The send of the drafts is its own route (S2); here are the drafts themselves and their counts.

const reviewDraftBodyMax = 3 * store.MaxArtifactCommentBody // bytes of a request

// RegisterReviewDrafts adds the draft routes.
func (h *SessionsHandler) RegisterReviewDrafts(r chi.Router) {
	r.Get("/api/artifacts/{id}/review-drafts", h.listReviewDrafts)
	r.With(RefuseSignInLink).Post("/api/artifacts/{id}/review-drafts", h.createReviewDraft)
	r.With(RefuseSignInLink).Patch("/api/artifacts/{id}/review-drafts/{cid}", h.editReviewDraft)
	r.Delete("/api/artifacts/{id}/review-drafts/{cid}", h.deleteReviewDraft)
	r.Get("/api/review-drafts/counts", h.reviewDraftCounts)
}

// reviewDraftView is one draft as the client sees it.
type reviewDraftView struct {
	ID         int64          `json:"id"`
	Board      string         `json:"board"`
	ParentID   *int64         `json:"parent_id"`
	Anchor     *commentAnchor `json:"anchor"`
	Body       string         `json:"body"`
	Images     []commentImage `json:"images,omitempty"`
	Source     string         `json:"source"`
	SourceName string         `json:"source_name,omitempty"`
	CreatedAt  string         `json:"created_at"`
	UpdatedAt  string         `json:"updated_at"`
	Revision   int64          `json:"revision"`
}

func draftView(d store.ReviewDraft, rev int64) reviewDraftView {
	v := reviewDraftView{ID: d.ID, Board: d.Board, ParentID: d.ParentID, Body: d.Body, Images: parseCommentImages(d.ImagesJSON), Source: d.Source,
		SourceName: d.SourceName, CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt, Revision: rev}
	if d.AnchorJSON != "" {
		var a commentAnchor
		if json.Unmarshal([]byte(d.AnchorJSON), &a) == nil {
			v.Anchor = &a
		}
	}
	return v
}

// reviewDraftOwner answers for the one who may hold drafts: the owner of this computer (through a Hub, the linked owner and nobody else). It returns the reviewer's key, and refuses the request itself otherwise.
func (h *SessionsHandler) reviewDraftOwner(w http.ResponseWriter, r *http.Request) (key string, caller commentCaller, ok bool) {
	if cloud.Tunneled(r) && refuseNonOwner(w, r) {
		return "", caller, false
	}
	if r.Header.Get(tunnel.ViaHeader) != "" { // through a Hub: the stamp must be genuine and the owner marker the linked owner's (refuseNonOwner above); the drafts are that owner's, as their comments are
		if !cloud.TunneledAuthentic(r) {
			commentRefuse(w, http.StatusForbidden, "forged_tunnel_stamp", "not allowed")
			return "", caller, false
		}
		id := hubOwnerRequest(r)
		if !id.owner {
			commentRefuse(w, http.StatusForbidden, "comments_forbidden", "only the person at this computer can keep review drafts")
			return "", caller, false
		}
		if id.team {
			caller = commentCaller{Kind: commentCallerOwner, Issuer: commentTeamIssuer(id.org), Subject: id.hubUserID, Name: cleanCommentName(id.pseudo), ViaHub: true}
		} else {
			issuer, subject, name := h.ownerIdentity(r)
			caller = commentCaller{Kind: commentCallerOwner, Issuer: issuer, Subject: subject, Name: cleanCommentName(name), ViaHub: true}
		}
	} else {
		var status int
		var code string
		caller, status, code = h.artifactCommentCaller(r)
		if status != 0 {
			commentRefuse(w, status, code, "not allowed")
			return "", caller, false
		}
	}
	if caller.Kind != commentCallerOwner {
		commentRefuse(w, http.StatusForbidden, "comments_forbidden", "only the person at this computer can keep review drafts")
		return "", caller, false
	}
	h.keepOwnerSubject(r.Context(), &caller)
	if caller.Subject == "" {
		commentRefuse(w, http.StatusServiceUnavailable, "owner_identity_unavailable", "this computer could not make an identity for its owner, so the draft was not kept")
		return "", caller, false
	}
	return caller.Issuer + "|" + caller.Subject, caller, true
}

// reviewDraftArtifact is the document the drafts are on: a file by its digest that this caller may read and that takes drafts. A goal, a diff and a video are refused (400 drafts_not_supported).
func (h *SessionsHandler) reviewDraftArtifact(w http.ResponseWriter, r *http.Request) (id string, textLike, ok bool) {
	raw := chi.URLParam(r, "id")
	if strings.HasPrefix(raw, "diff:") || strings.HasPrefix(raw, "goal:") {
		commentRefuse(w, http.StatusBadRequest, "drafts_not_supported", "drafts are for documents; a goal, a diff or a video comment goes as it is written")
		return "", false, false
	}
	id, textLike, ok = h.commentArtifactKind(w, r)
	if !ok {
		return "", false, false
	}
	if h.videoCommentArtifact(id) {
		commentRefuse(w, http.StatusBadRequest, "drafts_not_supported", "drafts are for documents; a goal, a diff or a video comment goes as it is written")
		return "", false, false
	}
	return id, textLike, true
}

func reviewBoardOf(w http.ResponseWriter, board string) (string, bool) {
	if board != "" && !validCommentBoard(board) {
		errBadRequest(w, "invalid board")
		return "", false
	}
	return board, true
}

// GET /api/artifacts/{id}/review-drafts?board=
func (h *SessionsHandler) listReviewDrafts(w http.ResponseWriter, r *http.Request) {
	key, caller, ok := h.reviewDraftOwner(w, r)
	if !ok {
		return
	}
	id, _, ok := h.reviewDraftArtifact(w, r)
	if !ok {
		return
	}
	board, ok := reviewBoardOf(w, r.URL.Query().Get("board"))
	if !ok {
		return
	}
	drafts, rev, err := h.ss.ListReviewDrafts(r.Context(), id, key)
	if err != nil {
		slog.Warn("[review drafts] list failed", "error", err)
		errInternalServer(w, "could not read the drafts")
		return
	}
	views := make([]reviewDraftView, 0, len(drafts))
	for _, d := range drafts {
		views = append(views, draftView(d, rev))
	}
	canWrite, canSend, reason := true, false, ""
	targets := []string{}
	if h.commentLocked(r, id, board) {
		canWrite, reason = false, "comments_locked"
	}
	switch {
	case len(views) == 0:
	case h.boardHandler != nil && board != "" && h.boardHandler.IsPaused(board):
		if reason == "" {
			reason = "board_paused"
		}
	default:
		ts, _, why := h.reviewTargets(r.Context(), id, board, drafts)
		for _, t := range ts {
			targets = append(targets, t.title)
		}
		canSend = why == "" && canWrite && h.operatorComment(r, caller)
		if reason == "" {
			reason = why
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"drafts": views, "revision": rev, "count": len(views), "limit": store.MaxReviewDrafts, "drafts_supported": true,
		"can_write": canWrite, "can_send": canSend, "reason": reason, "targets": targets})
}

// POST /api/artifacts/{id}/review-drafts {board, body, anchor | parent_id, images}
func (h *SessionsHandler) createReviewDraft(w http.ResponseWriter, r *http.Request) {
	key, caller, ok := h.reviewDraftOwner(w, r)
	if !ok {
		return
	}
	id, textLike, ok := h.reviewDraftArtifact(w, r)
	if !ok {
		return
	}
	var in struct {
		Board    string         `json:"board"`
		Body     string         `json:"body"`
		Anchor   *commentAnchor `json:"anchor"`
		ParentID *int64         `json:"parent_id"`
		Images   []string       `json:"images"`
	}
	if !readJSONBody(w, r, reviewDraftBodyMax, &in) {
		return
	}
	if _, ok := reviewBoardOf(w, in.Board); !ok {
		return
	}
	if h.commentLocked(r, id, in.Board) {
		commentRefuse(w, http.StatusConflict, "comments_locked", "comments on this artifact are locked")
		return
	}
	if len(in.Body) > store.MaxArtifactCommentBody {
		errPayloadTooLarge(w, "a comment is at most "+strconv.Itoa(store.MaxArtifactCommentBody)+" bytes")
		return
	}
	anchorJSON := ""
	if in.ParentID == nil {
		msg, unchecked := cleanAnchor(in.Anchor)
		if msg != "" {
			errBadRequest(w, msg)
			return
		}
		if unchecked {
			commentRefuse(w, http.StatusServiceUnavailable, "redaction_unavailable", "the selected text could not be checked for secrets, so the draft was not kept")
			return
		}
		if !textLike && !in.Anchor.Whole {
			commentRefuse(w, http.StatusUnsupportedMediaType, "not_text", "this kind of file takes comments on the whole document only")
			return
		}
		b, _ := json.Marshal(in.Anchor)
		anchorJSON = string(b)
	} else if in.Anchor != nil {
		errBadRequest(w, "a reply has no anchor: it is in its thread")
		return
	}
	imagesJSON := ""
	if len(in.Images) > 0 {
		var msg string
		if imagesJSON, msg = h.commentImagesOf(id, in.Images); msg != "" {
			errBadRequest(w, msg)
			return
		}
	}
	body, ok := redactComment(in.Body)
	if !ok {
		commentRefuse(w, http.StatusServiceUnavailable, "redaction_unavailable", "the draft could not be checked for secrets, so it was not kept")
		return
	}
	if !h.commentRate(w, caller) {
		return
	}
	if in.ParentID != nil { // a reply to a reply belongs to the thread's first comment, as for a comment
		if p, found, perr := h.ss.GetArtifactComment(r.Context(), id, *in.ParentID); perr == nil && found && p.ParentID != nil {
			in.ParentID = p.ParentID
		}
	}
	d, rev, err := h.ss.CreateReviewDraft(r.Context(), store.ReviewDraft{ArtifactID: id, Owner: key, Board: in.Board, ParentID: in.ParentID, AnchorJSON: anchorJSON, Body: body, ImagesJSON: imagesJSON})
	if h.draftWriteFailed(w, err, rev) {
		return
	}
	_, count, _ := h.draftCount(r, id, key)
	writeJSON(w, http.StatusCreated, map[string]any{"draft": draftView(d, rev), "revision": rev, "count": count})
}

func (h *SessionsHandler) draftCount(r *http.Request, id, key string) ([]store.ReviewDraft, int, error) {
	ds, _, err := h.ss.ListReviewDrafts(r.Context(), id, key)
	return ds, len(ds), err
}

// draftWriteFailed answers a store error of a draft write and says whether it did.
func (h *SessionsHandler) draftWriteFailed(w http.ResponseWriter, err error, rev int64) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrCommentEmpty):
		errBadRequest(w, "a draft needs some text")
	case errors.Is(err, store.ErrCommentTooLong):
		errPayloadTooLarge(w, "that draft is too long")
	case errors.Is(err, store.ErrDraftLimit):
		commentRefuse(w, http.StatusConflict, "draft_limit", "this document already has the most drafts you can hold: send or delete some")
	case errors.Is(err, store.ErrBadParent):
		errBadRequest(w, "that comment cannot be replied to")
	case errors.Is(err, store.ErrNoDraft):
		errNotFound(w, "no such draft")
	case errors.Is(err, store.ErrStaleRevision):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "the drafts changed since you read them: reload them", "code": "stale_revision", "revision": rev})
	default:
		slog.Warn("[review drafts] write failed", "error", err)
		errInternalServer(w, "could not keep the draft")
	}
	return true
}

func draftIDOf(w http.ResponseWriter, r *http.Request) (int64, bool) {
	n, err := strconv.ParseInt(chi.URLParam(r, "cid"), 10, 64)
	if err != nil || n <= 0 {
		errBadRequest(w, "invalid draft id")
		return 0, false
	}
	return n, true
}

// PATCH /api/artifacts/{id}/review-drafts/{cid} {body, images, revision}
func (h *SessionsHandler) editReviewDraft(w http.ResponseWriter, r *http.Request) {
	key, caller, ok := h.reviewDraftOwner(w, r)
	if !ok {
		return
	}
	id, _, ok := h.reviewDraftArtifact(w, r)
	if !ok {
		return
	}
	did, ok := draftIDOf(w, r)
	if !ok {
		return
	}
	var in struct {
		Body     string   `json:"body"`
		Images   []string `json:"images"`
		Revision *int64   `json:"revision"`
	}
	if !readJSONBody(w, r, reviewDraftBodyMax, &in) {
		return
	}
	if in.Revision == nil {
		errBadRequest(w, "send the revision you read")
		return
	}
	if cur, _, lerr := h.ss.ListReviewDrafts(r.Context(), id, key); lerr == nil { // a locked document takes no change to a draft, as it takes no new one
		for _, d := range cur {
			if d.ID == did && h.commentLocked(r, id, d.Board) {
				commentRefuse(w, http.StatusConflict, "comments_locked", "comments on this artifact are locked")
				return
			}
		}
	}
	if len(in.Body) > store.MaxArtifactCommentBody {
		errPayloadTooLarge(w, "a comment is at most "+strconv.Itoa(store.MaxArtifactCommentBody)+" bytes")
		return
	}
	imagesJSON := ""
	if len(in.Images) > 0 {
		var msg string
		if imagesJSON, msg = h.commentImagesOf(id, in.Images); msg != "" {
			errBadRequest(w, msg)
			return
		}
	}
	body, ok := redactComment(in.Body)
	if !ok {
		commentRefuse(w, http.StatusServiceUnavailable, "redaction_unavailable", "the draft could not be checked for secrets, so it was not kept")
		return
	}
	if !h.commentRate(w, caller) {
		return
	}
	d, rev, err := h.ss.UpdateReviewDraft(r.Context(), id, key, did, body, imagesJSON, *in.Revision)
	if h.draftWriteFailed(w, err, rev) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"draft": draftView(d, rev), "revision": rev})
}

// DELETE /api/artifacts/{id}/review-drafts/{cid}?revision=
func (h *SessionsHandler) deleteReviewDraft(w http.ResponseWriter, r *http.Request) {
	key, _, ok := h.reviewDraftOwner(w, r)
	if !ok {
		return
	}
	id, _, ok := h.reviewDraftArtifact(w, r)
	if !ok {
		return
	}
	did, ok := draftIDOf(w, r)
	if !ok {
		return
	}
	rev, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
	if err != nil {
		errBadRequest(w, "send the revision you read")
		return
	}
	count, cur, err := h.ss.DeleteReviewDraft(r.Context(), id, key, did, rev)
	if h.draftWriteFailed(w, err, cur) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count, "revision": cur})
}

// GET /api/review-drafts/counts: how many drafts the reviewer holds on each version.
func (h *SessionsHandler) reviewDraftCounts(w http.ResponseWriter, r *http.Request) {
	key, _, ok := h.reviewDraftOwner(w, r)
	if !ok {
		return
	}
	counts, err := h.ss.ReviewDraftCounts(r.Context(), key)
	if err != nil {
		errInternalServer(w, "could not read the drafts")
		return
	}
	out := make([]map[string]any, 0, len(counts))
	for id, n := range counts {
		out = append(out, map[string]any{"artifact_id": id, "count": n})
	}
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": out})
}

// ReviewDraftCountsFor is how many drafts the owner of this request holds on each version: the Inbox rows say it (#21194). The owner's alone; a read that is not theirs has none.
func (h *SessionsHandler) ReviewDraftCountsFor(r *http.Request) (map[string]int, error) {
	issuer, subject, _ := h.ownerIdentity(r)
	if subject == "" || h.ss == nil {
		return nil, nil
	}
	return h.ss.ReviewDraftCounts(r.Context(), issuer+"|"+subject)
}
