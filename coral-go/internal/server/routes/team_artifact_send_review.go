package routes

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/mediatype"
)

// Send for review (#13217, the server part of #13152): the Operator puts one of the team's files into their own Needs you, or takes it out again, from the Artifacts tab. A file for review is the tag "for review" and
// a question (#11555), as an upload with --tag does it; these two routes are the Operator's way to the same state without the tag editor, which through Coral Hub may only add or remove "read" (#13117).
// PUT and DELETE /api/board/{project}/artifacts/{id}/review. Like the Operator's review (POST on the same path) they are the OWNER's: this computer's person, and through Coral Hub the account it is linked to.

// reviewAnswer is the body both routes answer, so the page redraws without a second read.
type reviewAnswer struct {
	ID       string   `json:"id"`
	Tags     []string `json:"tags"`
	Question string   `json:"question"`
}

// MarkArtifactForReview puts a file in Needs you: the tag "for review", and the question when one is given (it may be empty: the Operator's own file needs none). A file already for review keeps its tag and has its
// question replaced. A file Needs you cannot show is refused as an upload with the tag is, and so is a question that is a sign-in link; a file that already has five tags takes no sixth.
// PUT /api/board/{project}/artifacts/{id}/review  {"question": "what to decide, one line, at most 140 characters"}
func (h *BoardHandler) MarkArtifactForReview(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	project := urlParam(r, "project")
	id := strings.ToLower(chi.URLParam(r, "id"))
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var body struct {
		Question string `json:"question"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	ctx := r.Context()
	item, ok := h.teamManagedArtifact(ctx, project, id)
	if !ok {
		errNotFound(w, "this team has no such artifact")
		return
	}
	if meta, _ := h.objectSidecar(id); meta.Digest != "" && !mediatype.Viewable(meta.MediaType, item.Name) {
		writeError(w, http.StatusBadRequest, "not_viewable", notViewableForReview(item.Name, meta.MediaType))
		return
	}
	if hasSignInLink(body.Question) {
		writeError(w, http.StatusBadRequest, "sign_in_link", signInLinkRefusal)
		return
	}
	question, _ := board.CleanReviewQuestion(body.Question) // empty once cleaned: none, and an earlier one is kept
	// The row of the send is written in the same transaction as the send (Security's SHOULD on #13231): a row that cannot be written undoes the send.
	sendCtx := board.WithActivity(context.WithoutCancel(ctx), activityMetaFor(r, item.Name, question))
	if throughAHub(r) { // a decided file is final through a hub (#13494): sending it again starts a new round, which stays a local act
		sendCtx = board.WithOneDecision(sendCtx)
	}
	tags, _, err := h.bs.StartArtifactReview(sendCtx, project, id, time.Now()) // a file decided before starts a new round (#13231)
	if errors.Is(err, board.ErrAlreadyDecided) {
		commentRefuse(w, http.StatusConflict, "already_decided", alreadyDecidedWords)
		return
	}
	if errors.Is(err, board.ErrArtifactTag) {
		writeError(w, http.StatusBadRequest, "too_many_tags", "this file already has the most tags a file can have; remove one to send it for review")
		return
	}
	if err != nil {
		errInternalServer(w, "could not mark the file for review")
		return
	}
	if question != "" {
		if err := h.bs.SetArtifactQuestionByOperator(ctx, project, id, question, time.Now()); err != nil {
			errInternalServer(w, "could not record the question")
			return
		}
	}
	h.writeReviewAnswer(w, r, project, id, tags)
}

// UnmarkArtifactForReview takes a file out of Needs you: the tag "for review" goes, and with it the question, as in the tag editor. A file that is not for review is answered as it is.
// DELETE /api/board/{project}/artifacts/{id}/review
func (h *BoardHandler) UnmarkArtifactForReview(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	project := urlParam(r, "project")
	id := strings.ToLower(chi.URLParam(r, "id"))
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	ctx := r.Context()
	if !h.teamHasManagedArtifact(ctx, project, id) {
		errNotFound(w, "this team has no such artifact")
		return
	}
	if throughAHub(r) && h.hasDecision(ctx, project, id) { // taking a decided file off is local too (#13494)
		commentRefuse(w, http.StatusConflict, "already_decided", alreadyDecidedWords)
		return
	}
	// The write is a compare-and-set on the tags read (#13129): a tag edit made meanwhile is not lost; the read is taken again a few times.
	for attempt := 0; ; attempt++ {
		all, err := h.bs.ArtifactTags(ctx, project)
		if err != nil {
			errInternalServer(w, "could not read the tags")
			return
		}
		was := all[id]
		reviewDeleteAfterRead()
		if !hasTag(was, tagForReview) {
			h.writeReviewAnswer(w, r, project, id, was)
			return
		}
		err = h.bs.TakeArtifactOutOfReview(board.WithActivity(context.WithoutCancel(ctx), activityMetaFor(r, h.artifactNameOf(ctx, project, id), "")), project, id, was, withoutTag(was, tagForReview))
		if err == nil {
			break
		}
		if err != board.ErrArtifactTagsChanged {
			errInternalServer(w, "could not take the file out of review")
			return
		}
		if attempt >= hubTagsRetries {
			errConflict(w, "the tags changed while this was being saved; try again")
			return
		}
	}
	all, _ := h.bs.ArtifactTags(ctx, project)
	h.writeReviewAnswer(w, r, project, id, all[id])
}

// artifactNameOf is the file's name as the team lists it, for a record; "" when it cannot be found.
func (h *BoardHandler) artifactNameOf(ctx context.Context, project, id string) string {
	if item, ok := h.teamManagedArtifact(ctx, project, id); ok {
		return item.Name
	}
	return ""
}

// writeReviewAnswer answers with the file's tags and the question it carries now.
func (h *BoardHandler) writeReviewAnswer(w http.ResponseWriter, r *http.Request, project, id string, tags []string) {
	question := ""
	if qs, err := h.bs.ArtifactQuestions(r.Context(), project); err == nil {
		question = qs[id].Question
	}
	if tags == nil {
		tags = []string{}
	}
	writeJSON(w, http.StatusOK, reviewAnswer{ID: id, Tags: tags, Question: question})
}

// reviewDeleteAfterRead is a seam for a test: it runs once DELETE has read the file's tags and before it writes (a local tag edit landing here must not be lost).
var reviewDeleteAfterRead = func() {}
