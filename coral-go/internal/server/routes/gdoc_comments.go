package routes

// Share to Google Docs, slice D of #20010: the comments people make in a shared Doc come back as comments on the artifact, in the same loop as the push (one Drive call per Doc a pass, off with
// the switch, paused with the Doc, the same 429 backoff). Only a display name comes across, never an email. The text is redacted like any comment, a Google comment is added once (the map says which
// ones are already here), and the agent that uploaded the version is told once per new comment or reply, in words that say it came from the Doc and is data.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/gdocsync"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
)

const (
	gdocPullPerPass   = 50 // new comments and replies taken from one Doc in one pass; the rest come next pass
	gdocAuthorIssuer  = "google-docs"
	gdocAuthorKind    = "google"
	gdocAuthorSubject = "google-docs" // a fixed subject: the Doc id is not kept on a comment
	gdocResolveIssuer = "google-docs"
)

// gdocPullComments mirrors one Doc's Google comments onto the newest version of its series. A failed Google call is returned (the loop backs off on a 429); anything else about one comment is skipped
// and tried again next pass, so nothing is lost and nothing is added twice.
func (h *SessionsHandler) gdocPullComments(ctx context.Context, c *gdocsync.Client, sh store.GdocShare, m seriesMember) error {
	comments, err := c.Comments(ctx, sh.DocID)
	if err != nil {
		return err
	}
	var seen []string // what this pull saw: an agent's reply goes only to one of these
	for _, cm := range comments {
		seen = append(seen, cm.ID)
		for _, rp := range cm.Replies {
			seen = append(seen, cm.ID+"/"+rp.ID)
		}
	}
	if err := h.ss.SetGdocCommentsSeen(ctx, sh.DocID, seen); err != nil {
		return err
	}
	mapped, err := h.ss.GdocCommentMap(ctx, sh.DocID)
	if err != nil {
		return err
	}
	// A team's Doc comments are held as drafts for the reviewer to send from Coral (#21196): the import notifies no one and keeps nothing as the owner's own words. A file of an agent on no team has no board to send
	// on, so its comments stay as they were.
	asDrafts := m.Board != "" && m.Board != noTeamBoardID
	ownerKey, pending := "", map[string]bool{}
	if asDrafts {
		if ownerKey = h.gdocOwnerKey(ctx); ownerKey == "" {
			return nil // no identity to hold the drafts under yet: nothing is imported, and the next pass tries again
		}
		if pending, err = h.ss.GdocDraftRefs(ctx, m.Digest); err != nil {
			return err
		}
		keep := map[string]bool{}
		for _, id := range seen {
			keep[sh.DocID+"|"+id] = true
		}
		if n, derr := h.ss.DeleteGdocDraftsGone(ctx, m.Digest, sh.DocID, keep); derr == nil && n > 0 {
			slog.Info("[gdoc] drafts of comments deleted in Google were dropped", "count", n)
		}
	}
	md := ""
	if b, _, ok := h.gdocReadVersion(m.Digest); ok {
		md = string(b)
	}
	budget := gdocPullPerPass
	for _, cm := range comments {
		if ctx.Err() != nil || budget <= 0 {
			return nil
		}
		root, have := mapped[cm.ID]
		rootRef := sh.DocID + "|" + cm.ID
		if !have && asDrafts {
			if !pending[rootRef] {
				if full := h.gdocHoldDraft(ctx, ownerKey, m, rootRef, gdocWho(cm.Author), nil, md, &cm, ""); full {
					return nil // the reviewer holds as many drafts as one version takes: the rest come after some are sent
				}
				pending[rootRef] = true
				budget--
			}
		} else if !have {
			cc := gdocsync.ToCoral(cm, md)
			body, ok := redactComment(cc.Body)
			if !ok {
				continue // fail closed: not kept until it can be checked
			}
			anchor := cc.Anchor
			if anchor.Quote != "" {
				if q, ok := redactComment(anchor.Quote); ok {
					anchor.Quote = q
				} else {
					anchor = gdocsync.CoralAnchor{Whole: true}
				}
			}
			ab, _ := json.Marshal(anchor)
			created, err := h.ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: m.Digest, Board: m.Board, AnchorJSON: string(ab), Body: body,
				AuthorIssuer: gdocAuthorIssuer, AuthorSubject: gdocAuthorSubject, AuthorName: gdocWho(cm.Author) + " via Google Docs", AuthorKind: gdocAuthorKind})
			if err != nil {
				slog.Warn("[gdoc] a Google comment could not be added", "error", err)
				continue
			}
			root = store.GdocCommentRow{DocID: sh.DocID, RemoteID: cm.ID, CommentID: created.ID}
			if err := h.ss.SaveGdocComment(ctx, root); err != nil {
				return err
			}
			budget--
			h.noteGdocComment(ctx, m, created, body, gdocWho(cm.Author))
		}
		for _, rp := range cm.Replies {
			rid := cm.ID + "/" + rp.ID
			if _, done := mapped[rid]; done || rp.ID == "" {
				continue
			}
			if asDrafts {
				ref := sh.DocID + "|" + rid
				if pending[ref] || rp.Content == "" {
					continue
				}
				var parent *int64
				if have {
					parent = &root.CommentID
				}
				if full := h.gdocHoldDraft(ctx, ownerKey, m, ref, gdocWho(rp.Author), parent, md, nil, gdocsync.Signed(rp.Author, rp.Content)); full {
					return nil
				}
				pending[ref] = true
				budget--
				continue
			}
			if rp.Content == "" { // a reply that only resolved or reopened the comment has no words to keep
				_ = h.ss.SaveGdocComment(ctx, store.GdocCommentRow{DocID: sh.DocID, RemoteID: rid, CommentID: root.CommentID})
				continue
			}
			body, ok := redactComment(gdocsync.Signed(rp.Author, rp.Content))
			if !ok {
				continue
			}
			parent := root.CommentID
			created, err := h.ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: m.Digest, Board: m.Board, ParentID: &parent, Body: body,
				AuthorIssuer: gdocAuthorIssuer, AuthorSubject: gdocAuthorSubject, AuthorName: gdocWho(rp.Author) + " via Google Docs", AuthorKind: gdocAuthorKind})
			if err != nil {
				continue
			}
			if err := h.ss.SaveGdocComment(ctx, store.GdocCommentRow{DocID: sh.DocID, RemoteID: rid, CommentID: created.ID}); err != nil {
				return err
			}
			budget--
			h.noteGdocComment(ctx, m, created, body, gdocWho(rp.Author))
		}
		// resolved in Google: resolved here, and reopened when Google reopens it (only a resolve that came from Google is undone)
		if cm.Resolved != root.Resolved && root.CommentID != 0 {
			if cm.Resolved {
				if cur, found, gerr := h.ss.GetArtifactComment(ctx, m.Digest, root.CommentID); gerr == nil && found && cur.ResolvedAt == nil { // already resolved here: whoever did it keeps it
					_, _, _ = h.ss.SetArtifactCommentResolved(ctx, m.Digest, root.CommentID, true, gdocResolveIssuer, gdocAuthorSubject)
				}
			} else if cur, found, gerr := h.ss.GetArtifactComment(ctx, m.Digest, root.CommentID); gerr == nil && found && cur.ResolvedIssuer != nil && *cur.ResolvedIssuer == gdocResolveIssuer {
				// reopened in Google: reopened here only when the resolve here was Google's own; a thread the owner or an agent resolved in Coral stays resolved
				_, _, _ = h.ss.SetArtifactCommentResolved(ctx, m.Digest, root.CommentID, false, "", "")
			}
			root.Resolved = cm.Resolved
			_ = h.ss.SaveGdocComment(ctx, root)
		}
	}
	return nil
}

// gdocOwnerKey is the reviewer key of the owner of this computer, for the imported drafts: the same one the draft routes give them. "" when this computer has no identity for its owner yet.
func (h *SessionsHandler) gdocOwnerKey(ctx context.Context) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
	if err != nil {
		return ""
	}
	issuer, subject, _ := h.ownerIdentity(req)
	c := commentCaller{Kind: commentCallerOwner, Issuer: issuer, Subject: subject}
	h.keepOwnerSubject(ctx, &c)
	if c.Subject == "" {
		return ""
	}
	return c.Issuer + "|" + c.Subject
}

// gdocHoldDraft keeps one Google comment (root, with its anchor made from the Doc's own words) or reply (words) as a draft of the owner, to be sent from Coral with the others. The text is redacted like any comment, and
// the name is Google's, kept as untrusted text. full is true when the owner already holds as many drafts as a version takes. Anything else that goes wrong is logged and the comment is tried again next pass.
func (h *SessionsHandler) gdocHoldDraft(ctx context.Context, owner string, m seriesMember, ref, who string, parent *int64, md string, root *gdocsync.Comment, replyText string) (full bool) {
	d := store.ReviewDraft{ArtifactID: m.Digest, Owner: owner, Board: m.Board, ParentID: parent, Source: store.ReviewDraftGdoc, SourceName: who, SourceRef: ref}
	text := replyText
	if root != nil {
		cc := gdocsync.ToCoral(*root, md)
		text = cc.Body
		anchor := cc.Anchor
		if anchor.Quote != "" {
			if q, ok := redactComment(anchor.Quote); ok {
				anchor.Quote = q
			} else {
				anchor = gdocsync.CoralAnchor{Whole: true}
			}
		}
		ab, _ := json.Marshal(anchor)
		d.AnchorJSON = string(ab)
	}
	body, ok := redactComment(text)
	if !ok {
		return false // fail closed: not kept until it can be checked
	}
	d.Body = body
	if _, _, err := h.ss.CreateReviewDraft(ctx, d); err != nil {
		if errors.Is(err, store.ErrDraftLimit) {
			return true
		}
		slog.Warn("[gdoc] a Google comment could not be held as a draft", "error", err)
	}
	return false
}

// gdocWho is a Google author's display name made fit to show: the name only, on one line, cut.
func gdocWho(a gdocsync.Author) string {
	n := cleanAgentName(a.DisplayName)
	if n == "" {
		return "Someone"
	}
	return n
}

// noteGdocComment tells the agent that uploaded the version about a new comment from the Doc: the team's board gets the usual comment message (the person is named as the author of untrusted data), an
// agent on no team gets one typed line. Best effort and logged without the text: the comment is already kept.
func (h *SessionsHandler) noteGdocComment(ctx context.Context, m seriesMember, c store.ArtifactComment, body, who string) {
	switch {
	case m.Board == noTeamBoardID:
		if h.boardHandler == nil {
			return
		}
		item, ok := h.boardHandler.noTeamManagedArtifact(ctx, m.Digest)
		if !ok {
			return
		}
		text, ok := sendQuote(body, 2*sendCommentCap)
		if !ok {
			return
		}
		h.boardHandler.tellNoTeamUploaderOf(ctx, m.Digest, typedNoTeamGdocComment(m.Digest, text, item.Name, who))
	case m.Board != "" && h.bs != nil && h.ss != nil:
		d := h.deliverBoardComment(ctx, "google|"+m.Digest, c, m.Digest, m.Board, board.TypedLabel(who))
		slog.Info("[gdoc] a Google comment was passed to the agent", "sent", d.To != "", "queued", d.Queued != "", "reason", d.Reason)
	}
}

// Slice G (#20012): an agent's reply (or resolve) on a thread that came from a Doc goes back to that Doc, as the Operator's Google account with the agent named in the text.
// It goes only to a comment the last pull saw (a thread that was deleted in Google is not written to), only when the switch is on and the Doc is live, within the Doc's hour bound, redacted and cut,
// and in ONE attempt: a write is never sent again on a guess, and one whose outcome is unknown pauses the Doc. A failure never undoes the Coral reply; it is only logged.

const gdocReplyCap = 4 << 10

// gdocSendBackLater is gdocSendBack off the request: the agent's reply is already saved and answered.
func (h *SessionsHandler) gdocSendBackLater(artifactID string, root store.ArtifactComment, agent, body string, resolve bool, replyID int64) {
	safego.Go("routes/gdoc-send-back", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		h.gdocSendBack(ctx, artifactID, root, agent, body, resolve, replyID)
	})
}

// gdocSendBack sends one agent reply or resolve to Google. root is the thread's first comment; replyID is the Coral reply that holds the text (0 for a bare resolve).
func (h *SessionsHandler) gdocSendBack(ctx context.Context, artifactID string, root store.ArtifactComment, agent, body string, resolve bool, replyID int64) {
	if h.ss == nil || root.ParentID != nil {
		return
	}
	mirror, err := h.ss.GdocCommentOf(ctx, root.ID)
	if err != nil || mirror == nil || !mirror.Seen {
		return // not a thread from a Doc, or the last pull did not see it
	}
	settings, err := h.ss.GetSettings(ctx)
	if err != nil || !gdocSwitchOn(settings) || !gdocMac() {
		return
	}
	sh, err := h.ss.GetGdocShareByDoc(ctx, mirror.DocID)
	if err != nil || sh == nil || sh.State != store.GdocShareLive {
		return // stopped, paused, or a Doc that was kept after a keep-both
	}
	who := cleanAgentName(agent)
	if who == "" {
		who = "An agent"
	}
	text := strings.TrimSpace(body)
	if text == "" && resolve {
		text = "Resolved."
	}
	if text == "" {
		return
	}
	red, rerr := secrets.Redactor().Text([]byte("[" + who + " via Coral] " + text))
	if rerr != nil {
		slog.Warn("[gdoc] an agent's reply was not sent: it could not be checked for secrets")
		return
	}
	out := string(red)
	if r := []rune(out); len(r) > gdocReplyCap {
		out = string(r[:gdocReplyCap])
	}
	if !gdocWrites.allow(sh.Key, time.Now()) {
		slog.Warn("[gdoc] an agent's reply was not sent: this Doc was changed 20 times in the last hour")
		return
	}
	c, err := gdocClientFor()
	if err != nil {
		return
	}
	if _, err := c.TokenFunc(); err != nil {
		return
	}
	action := ""
	if resolve {
		action = "resolve"
	}
	rid, err := c.ReplyID(ctx, mirror.DocID, mirror.RemoteID, out, action) // one attempt
	switch {
	case err == nil:
	case errors.Is(err, gdocsync.ErrOutcomeUnknown):
		_, _ = h.ss.SetGdocShareState(ctx, sh.Key, store.GdocSharePaused)
		slog.Warn("[gdoc] an agent's reply may or may not have reached the Doc; syncing that Doc is paused until the owner resumes it")
		return
	default:
		slog.Warn("[gdoc] an agent's reply was not accepted by Google", "kind", gdocErrKind(err))
		return
	}
	// The pull must take the reply for ours: map it to the Coral reply, and the resolve to the thread.
	if rid != "" && replyID != 0 {
		_ = h.ss.SaveGdocComment(ctx, store.GdocCommentRow{DocID: mirror.DocID, RemoteID: mirror.RemoteID + "/" + rid, CommentID: replyID, Seen: true})
	}
	if resolve {
		mirror.Resolved = true
		_ = h.ss.SaveGdocComment(ctx, *mirror)
	}
}
