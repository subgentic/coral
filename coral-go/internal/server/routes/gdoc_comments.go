package routes

// Share to Google Docs, slice D of #20010: the comments people make in a shared Doc come back as comments on the artifact, in the same loop as the push (one Drive call per Doc a pass, off with
// the switch, paused with the Doc, the same 429 backoff). Only a display name comes across, never an email. The text is redacted like any comment, a Google comment is added once (the map says which
// ones are already here), and the agent that uploaded the version is told once per new comment or reply, in words that say it came from the Doc and is data.

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/gdocsync"
	"github.com/subgentic/coral/internal/store"
)

const (
	gdocPullPerPass   = 50 // new comments and replies taken from one Doc in one pass; the rest come next pass
	gdocAuthorIssuer  = "google-docs"
	gdocAuthorKind    = "google"
	gdocResolveIssuer = "google-docs"
)

// gdocPullComments mirrors one Doc's Google comments onto the newest version of its series. A failed Google call is returned (the loop backs off on a 429); anything else about one comment is skipped
// and tried again next pass, so nothing is lost and nothing is added twice.
func (h *SessionsHandler) gdocPullComments(ctx context.Context, c *gdocsync.Client, sh store.GdocShare, m seriesMember) error {
	comments, err := c.Comments(ctx, sh.DocID)
	if err != nil {
		return err
	}
	mapped, err := h.ss.GdocCommentMap(ctx, sh.DocID)
	if err != nil {
		return err
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
		if !have {
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
				AuthorIssuer: gdocAuthorIssuer, AuthorSubject: sh.DocID, AuthorName: gdocWho(cm.Author) + " via Google Docs", AuthorKind: gdocAuthorKind})
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
				AuthorIssuer: gdocAuthorIssuer, AuthorSubject: sh.DocID, AuthorName: gdocWho(rp.Author) + " via Google Docs", AuthorKind: gdocAuthorKind})
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
				_, _, _ = h.ss.SetArtifactCommentResolved(ctx, m.Digest, root.CommentID, true, gdocResolveIssuer, sh.DocID)
			} else {
				_, _, _ = h.ss.SetArtifactCommentResolved(ctx, m.Digest, root.CommentID, false, "", "")
			}
			root.Resolved = cm.Resolved
			_ = h.ss.SaveGdocComment(ctx, root)
		}
	}
	return nil
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
