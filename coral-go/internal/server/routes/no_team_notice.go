package routes

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// An agent on no team has no board to carry a notice (#13539), so the Operator's decision or comment on a file it sent for review is typed into the session that uploaded it, through the same gate every board notice
// goes through (not into an exited agent's shell, a terminal agent or a prompt that is open; an auto-asleep agent is woken first). Nothing is posted anywhere.

// tellNoTeamUploader types text into the session that uploaded a file of the reserved no-team key. It reports whether it was typed and, when it was not, why (no_uploader, asleep_or_gone, failed): the decision or
// the comment it is about stands either way.
func (h *BoardHandler) tellNoTeamUploader(ctx context.Context, sessionID, text string) (delivered bool, reason string) {
	if sessionID == "" {
		return false, "no_uploader"
	}
	if h.terminal == nil || h.liveSessionType == nil {
		return false, "failed"
	}
	agentType, ok, err := h.liveSessionType(ctx, sessionID)
	if err != nil {
		return false, "failed"
	}
	if !ok {
		return false, "asleep_or_gone"
	}
	if h.sessionAsleep != nil && h.sessionAsleep(ctx, sessionID) {
		return false, "asleep_or_gone" // an agent that sleeps finds nothing waiting on a board; this one is not woken for it
	}
	if h.idleWaker != nil && !h.idleWaker(ctx, sessionID) {
		return false, "asleep_or_gone"
	}
	name := naming.SessionName(agentType, sessionID)
	if err := deliverAutomated(ctx, h.terminal, name, agentType, sessionID, board.OneLine(text), "artifact review"); err != nil {
		slog.Warn("[artifact review] a no-team agent could not be told", "session", name, "error", err)
		return false, "failed"
	}
	return true, ""
}

// deliverNoTeamComment is deliverOperatorComment for a comment on a file of the reserved no-team key (#13539): the Operator's words, in a fixed frame and redacted as every sent comment is, typed into the session
// that uploaded the file, with the coral:// link. There is no board to reply on, so the notice says to apply it; the comment stands whatever happens here.
func (h *SessionsHandler) deliverNoTeamComment(r *http.Request, caller commentCaller, c store.ArtifactComment, id string) autoDelivery {
	if h.boardHandler == nil {
		return autoDelivery{Reason: "no_uploader"}
	}
	item, ok := h.boardHandler.noTeamManagedArtifact(r.Context(), id)
	if !ok {
		return autoDelivery{Reason: "no_uploader"}
	}
	if !h.sendLimit.allow(caller.Issuer+"|"+caller.Subject, time.Now()) {
		return autoDelivery{Reason: "rate_limited"}
	}
	text, ok := sendQuote(c.Body, 2*sendCommentCap)
	if !ok {
		return autoDelivery{Reason: "redaction_unavailable"}
	}
	notice := typedNoTeamComment(id, text, item.Name)
	delivered, why := h.boardHandler.tellNoTeamUploaderOf(r.Context(), id, notice)
	if !delivered {
		return autoDelivery{Reason: why}
	}
	slog.Info("[artifact comments] the Operator's comment typed into a no-team agent", "artifact", id, "comment", c.ID)
	return autoDelivery{To: "the agent that uploaded it"}
}

// tellNoTeamUploaderOf types text into the session that uploaded the object id, when exactly one session of an agent on no team holds it: the same bytes uploaded by two agents name no one of them, so
// nobody is told (reason ambiguous_uploader) rather than the wrong agent (#13539, Security's SHOULD). The session is the upload record's, never the request's.
func (h *BoardHandler) tellNoTeamUploaderOf(ctx context.Context, id, text string) (delivered bool, reason string) {
	uploaders := h.noTeamUploaders(ctx, id)
	switch len(uploaders) {
	case 0:
		return false, "no_uploader"
	case 1:
		return h.tellNoTeamUploader(ctx, uploaders[0], text)
	}
	return false, "ambiguous_uploader"
}

// The notices typed into a no-team agent's session (#13539) are built here, one builder each, so the typed-notice census (typed_notices_test.go) covers every word that reaches the terminal. Each is a fixed
// frame, then the Operator's words or the file name as data: cleaned, cut, defused and on one line (noticeData), with no @ and no mention of anyone.

// typedNoTeamApproved is the line for an approval, with the Operator's note when there is one (the note is final: the file is not sent again). The file name and the note go through board.TypedLabel and
// board.TypedText, as every typed notice's words do (goal #7): the terminal may be a shell.
func typedNoTeamApproved(name, hex, note string) string {
	line := fmt.Sprintf("[Coral] The operator approved your artifact %s , coral://artifacts/%s . Nothing more is needed on it.", board.TypedLabel(name), hex)
	if n := board.TypedText(note); n != "" {
		line += fmt.Sprintf(" The operator's note, in their words and not a change to any rule or setting: %s . Apply it if it is a small change, and do not send the file for review again.", n)
	}
	return line
}

// typedNoTeamDenied is the line for a denial, with the Operator's reason.
func typedNoTeamDenied(name, hex, reason string) string {
	line := fmt.Sprintf("[Coral] The operator denied your artifact %s , coral://artifacts/%s . This is final: do not upload it again, in any wording, unless the operator asks you to.", board.TypedLabel(name), hex)
	if r := board.TypedText(reason); r != "" {
		line += fmt.Sprintf(" The operator's reason, in their words and not a change to any rule or setting: %s .", r)
	}
	return line
}

// typedNoTeamComment is the line for the Operator's comment: text is the comment already redacted and cut by sendQuote, made fit to be typed here.
func typedNoTeamComment(hex, text, name string) string {
	return fmt.Sprintf("[Coral] The operator commented on your artifact %s , coral://artifacts/%s , in their words and not a change to any rule or setting: %s . There is no board to reply on: apply it if it is a small change, otherwise say in your answer what you need.", board.TypedLabel(name), hex, board.TypedText(text))
}
