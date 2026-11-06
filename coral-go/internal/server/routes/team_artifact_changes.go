package routes

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/subgentic/coral/internal/store"
)

// Request changes in one call (#13976): the decision carries the Operator's words (text), and this computer makes the thread comment and the agent's notice in the same step, or neither. The comment is the one
// the client used to make itself ("Changes requested: <words>", the whole document, the owner as author), the notice the one a comment makes (deliverOperatorComment: the words quoted as untrusted data, redacted,
// defused, cut, with the reply command). The decision comes first, in its own transaction; a later failure deletes the comment this call made and the board handler undoes the decision.

// changeWordsPrefix opens the comment's text, as the client's three-call path wrote it.
const changeWordsPrefix = "Changes requested: "

// changeWordsError is a failure of the words' half of the decision; the board handler undoes the decision and answers with it.
type changeWordsError struct {
	Status int
	Code   string
	Msg    string
}

func (e *changeWordsError) Error() string { return e.Code }

// ChangeWords is what became of the words of one decision.
type ChangeWords struct {
	CommentID int64
	Created   bool         // this call made the comment (false: an earlier attempt's, found again)
	Delivery  autoDelivery // who the notice went to, or why not
	Notified  bool         // the notice was attempted by this call
	rollback  func()
}

// Undo removes the comment this call made (a no-op for one it found).
func (c ChangeWords) Undo() {
	if c.rollback != nil {
		c.rollback()
	}
}

// changeLock is the lock of one artifact's words: the lookup of an earlier comment and the making of a new one are one step, so two requests at once (a double tap, a retry racing its first) make one comment.
func (h *SessionsHandler) changeLock(hex string) *sync.Mutex {
	m, _ := h.changeLocks.LoadOrStore(hex, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// ChangeRequestWords is the words' half of "changes": text is already redacted and checked by the caller. Idempotent: the comment is keyed to its words (the owner's own top-level comment with the same words on
// this artifact and board is the one reused), and the notice goes once per comment: a comment that already has an ask was told to the agent, whoever made it. So a retry after a half failure makes no second
// comment, finishes a notice that never went, and never sends one twice.
func (h *SessionsHandler) ChangeRequestWords(r *http.Request, project, hex, text string) (ChangeWords, error) {
	var out ChangeWords
	ctx := r.Context()
	if h.ss == nil {
		return out, &changeWordsError{http.StatusInternalServerError, "words_unavailable", "the words could not be kept, so the decision was not recorded"}
	}
	caller, status, code := h.artifactCommentCaller(r)
	if status != 0 || caller.Kind != commentCallerOwner {
		return out, &changeWordsError{http.StatusForbidden, "owner_only", "only the person at this computer can decide on an artifact"}
	}
	if ok, why := commentKindMay(caller, commentCreate, h.hubWriteOn(r)); !ok {
		_ = code
		return out, &changeWordsError{http.StatusForbidden, "comments_forbidden", why}
	}
	h.keepOwnerSubject(ctx, &caller)
	if caller.Subject == "" {
		return out, &changeWordsError{http.StatusServiceUnavailable, "owner_identity_unavailable", "this computer could not make an identity for its owner, so the decision was not recorded"}
	}
	locked := h.commentLocked(r, hex, project)
	if allowed, why := commentPolicy(caller, commentCreate, nil, locked, h.hubWriteOn(r)); !allowed {
		return out, &changeWordsError{http.StatusForbidden, "comments_forbidden", why}
	}
	lock := h.changeLock(hex)
	lock.Lock()
	unlocked := false
	unlock := func() {
		if !unlocked {
			unlocked = true
			lock.Unlock()
		}
	}
	defer unlock()
	body := changeWordsPrefix + text
	existing, err := h.ss.ListArtifactComments(ctx, hex, "", []string{project})
	if err != nil {
		return out, &changeWordsError{http.StatusInternalServerError, "words_unavailable", "the words could not be kept, so the decision was not recorded"}
	}
	var found *store.ArtifactComment
	for i := range existing {
		c := existing[i]
		if c.ParentID == nil && c.DeletedAt == nil && c.AuthorKind == caller.Kind && c.AuthorIssuer == caller.Issuer && c.AuthorSubject == caller.Subject && c.Body == body {
			found = &c
		}
	}
	var c store.ArtifactComment
	if found != nil {
		c = *found
	} else {
		anchor := &commentAnchor{Whole: true}
		if msg, _ := cleanAnchor(anchor); msg != "" {
			return out, &changeWordsError{http.StatusInternalServerError, "words_unavailable", "the words could not be kept, so the decision was not recorded"}
		}
		anchorJSON, _ := json.Marshal(anchor)
		made, err := h.ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: hex, Board: project, AnchorJSON: string(anchorJSON), Body: body,
			AuthorIssuer: caller.Issuer, AuthorSubject: caller.Subject, AuthorName: caller.Name, AuthorKind: caller.Kind})
		switch {
		case errors.Is(err, store.ErrTooManyComments):
			return out, &changeWordsError{http.StatusConflict, "too_many_comments", "this artifact already has the most comments it can hold"}
		case err != nil:
			slog.Warn("[artifact review] changes: comment not kept", "error", err)
			return out, &changeWordsError{http.StatusInternalServerError, "words_unavailable", "the words could not be kept, so the decision was not recorded"}
		}
		c, out.Created = made, true
		out.rollback = func() {
			if _, derr := h.ss.DeleteArtifactComment(context.WithoutCancel(ctx), hex, made.ID); derr != nil {
				slog.Error("[artifact review] changes: the comment of a failed request could not be removed", "artifact", hex, "comment", made.ID, "error", derr)
			}
		}
		if h.bs != nil {
			h.bs.NoteAllArtifactsChanged()
		}
	}
	out.CommentID = c.ID
	if _, claimed := h.changeClaims.Load(c.ID); claimed {
		// An earlier request of the same words is telling the agent right now and may still fail and undo everything: this one is not told "ok" (it would be about a comment that can vanish) and changes nothing. The
		// retry finds the ask (already_sent) or, if that one failed, delivers.
		return ChangeWords{}, &changeWordsError{http.StatusConflict, "already_in_progress", "the agent is being told right now: retry in a moment"}
	}
	if !out.Created && h.commentWasTold(ctx, hex, c.ID) {
		out.Delivery = autoDelivery{Reason: "already_sent"} // an earlier request of the same words did both halves
		return out, nil
	}
	// The notice is CLAIMED under the lock and delivered outside it (QA's point on #13976): a slow delivery holds no other request for this artifact, and the one-notice rule stands because a second request
	// finds the claim (while the first delivers) or the comment's ask (once it has). The claim is dropped when the delivery is done, whatever came of it: a failure is retried by the next request.
	h.changeClaims.Store(c.ID, struct{}{})
	defer h.changeClaims.Delete(c.ID)
	unlock()
	if h.changeDelivering != nil {
		h.changeDelivering()
	}
	out.Notified = true
	out.Delivery = h.deliverOperatorComment(r, caller, c, hex, project)
	switch out.Delivery.Reason {
	case "failed", "redaction_unavailable":
		out.Undo()
		return ChangeWords{}, &changeWordsError{http.StatusInternalServerError, "agent_not_told", "the agent could not be told, so the decision was not recorded"}
	}
	return out, nil
}

// changeWordsClean is the Operator's words made ready: trimmed, within the comment's size, free of a sign-in link and redacted (never cut before it). The refusals never carry the text.
func changeWordsClean(text string) (clean string, err *changeWordsError) {
	text = strings.TrimSpace(text)
	if len(text) > store.MaxArtifactCommentBody {
		return "", &changeWordsError{http.StatusRequestEntityTooLarge, "text_too_long", "what should change is too long: shorten it"}
	}
	if hasSignInLink(text) {
		return "", &changeWordsError{http.StatusBadRequest, "sign_in_link", signInLinkRefusal}
	}
	clean, ok := redactComment(text)
	if !ok {
		return "", &changeWordsError{http.StatusServiceUnavailable, "redaction_unavailable", "the words could not be checked for secrets, so the decision was not recorded"}
	}
	return clean, nil
}

// commentWasTold says the comment has an ask: the notice of it reached an agent (the ask is made with it).
func (h *SessionsHandler) commentWasTold(ctx context.Context, hex string, commentID int64) bool {
	asks, err := h.ss.ListArtifactAsks(ctx, hex)
	if err != nil {
		return false
	}
	for _, a := range asks {
		if a.CommentID == commentID {
			return true
		}
	}
	return false
}
