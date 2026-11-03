package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// Comments on an agent's diff (#12536, the Operator: "let me comment in the files diff view too, similar to how we handle the artifacts review"). They are the goal comments' machinery (#11955) pointed at
// one changed file of one live agent: the same routes, table, caps, threads, Resolve and Reopen, pictures, ask gate and agent reply, with a subject key in the place of an artifact's digest:
// diff:<team>:<session>:<16 hex of sha256(path)>. A digest is 64 hex characters, so a diff key is never an artifact (every artifact route refuses it), and Coral Hub's table matches routes on {hex64}, so a diff
// key is never reached through the Hub: this slice is the person at this computer's, and an agent's reply into a thread it was asked into.
//
// The file is the one the agent's changed list names (the cached list the Files panel reads: nothing is read from the disk here), the path is repo-relative and cleaned, and the quoted lines are the diff's
// own text: outside text, redacted before they are kept, capped, cleaned and defused before they reach an agent, and sent only inside the fixed frame of sendMessageOf.

const (
	maxDiffQuote      = 8 << 10 // bytes of the selected lines
	maxDiffQuoteLines = 200
	maxDiffContext    = 600 // bytes of the lines before and of the lines after
	maxDiffPath       = 1024
)

// maxDiffCommentsPerSession is the live comments one agent session's diffs hold in all (the store caps one file's key at store.MaxArtifactComments), so one session cannot fill the table (#12536, Security's point 5). A var so a test can lower it.
var maxDiffCommentsPerSession = 200

// diffSubjectRe is a diff's subject key: diff:<team>:<session id>:<16 hex>, the team as commentBoardRe has it.
var diffSubjectRe = regexp.MustCompile(`^diff:([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):([A-Za-z0-9][A-Za-z0-9_-]{5,63}):([0-9a-f]{16})$`)

// diffPathHash is the first 16 hex characters of the sha256 of the (raw, repo-relative) path.
func diffPathHash(p string) string {
	sum := sha256.Sum256([]byte(p))
	return hex.EncodeToString(sum[:8])
}

// diffSubject is the key of the file at p of the session on team.
func diffSubject(team, session, p string) string {
	return fmt.Sprintf("diff:%s:%s:%s", team, session, diffPathHash(p))
}

// parseDiffSubject reads a subject key; ok is false for anything else (an artifact's digest and a goal's key included).
func parseDiffSubject(s string) (team, session, hash string, ok bool) {
	m := diffSubjectRe.FindStringSubmatch(s)
	if m == nil {
		return "", "", "", false
	}
	return m[1], m[2], m[3], true
}

// diffTeamOf is the team a request's diff key names ("" when it is not one).
func diffTeamOf(r *http.Request) string {
	team, _, _, _ := parseDiffSubject(chi.URLParam(r, "id"))
	return team
}

// diffLink is the link an agent names a diff thread by: coral://diffs/<team>/<session>/<16 hex>.
func diffLink(team, session, hash string) string {
	return fmt.Sprintf("coral://diffs/%s/%s/%s", team, session, hash)
}

// repoPath is a path the changed list could hold: relative, with no .. or . element, no drive letter, no backslash, no control character, at most maxDiffPath bytes. It answers the cleaned form.
func repoPath(p string) (string, bool) {
	if p == "" || len(p) > maxDiffPath || !utf8.ValidString(p) || strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "/") {
		return "", false
	}
	if len(p) >= 2 && p[1] == ':' && unicode.IsLetter(rune(p[0])) {
		return "", false
	}
	for _, el := range strings.Split(p, "/") {
		if el == ".." || el == "." || el == "" {
			return "", false
		}
	}
	if c := path.Clean(p); c != p {
		return "", false
	}
	return p, true
}

// writeHidden shows what a name hides: a control, zero-width or bidi character is written as its code point, so a path cannot read as another file.
func writeHidden(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x200b || r == 0x200c || r == 0x200d || r == 0x2060 || r == 0xfeff || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0x2028 || r == 0x2029 {
			fmt.Fprintf(&b, "<U+%04X>", r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// diffSession is the live session a diff key names, on the team it names: a session that exists, is not archived, is not a terminal and belongs to that team's board.
func (h *SessionsHandler) diffSession(r *http.Request, team, sid string) (*store.LiveSession, bool) {
	if h.ss == nil {
		return nil, false
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sid)
	if err != nil || ls == nil || ls.IsArchived == 1 || ls.AgentType == "terminal" {
		return nil, false
	}
	if ls.BoardName == nil || *ls.BoardName != team {
		return nil, false
	}
	return ls, true
}

// diffCommentSubject is commentArtifactKind for a diff key: a key that parses, a live session of that team, and a caller that is the person at this computer or an agent. Through Coral Hub it is refused
// (this slice is the computer's own). It answers the request itself when not and reports false.
func (h *SessionsHandler) diffCommentSubject(w http.ResponseWriter, r *http.Request, id string) bool {
	team, sid, _, ok := parseDiffSubject(id)
	if !ok {
		errBadRequest(w, "invalid diff")
		return false
	}
	if cloud.Tunneled(r) {
		commentRefuse(w, http.StatusForbidden, "owner_only", "comments on a diff are for the person at this computer")
		return false
	}
	caller, status, code := h.artifactCommentCaller(r)
	if status != 0 {
		commentRefuse(w, status, code, "not allowed")
		return false
	}
	if caller.Kind != commentCallerOwner && caller.Kind != commentCallerAgent {
		commentRefuse(w, http.StatusForbidden, "owner_only", "comments on a diff are for the person at this computer and the agents asked into a thread")
		return false
	}
	if _, ok := h.diffSession(r, team, sid); !ok {
		errNotFound(w, "that agent is not running")
		return false
	}
	return true
}

// cleanDiffAnchor validates and prepares the anchor of a comment on the diff of file key id: the path is the key's file and is in the agent's changed list, the side and lines are sane, and the lines the
// comment copies are capped and redacted. When the redactor cannot check them the range and the path are kept without the lines, and the anchor says so (Withheld). msg is a refusal.
func (h *SessionsHandler) cleanDiffAnchor(r *http.Request, id string, a *commentAnchor) (msg string) {
	team, sid, hash, ok := parseDiffSubject(id)
	if !ok || a == nil {
		return "an anchor is required"
	}
	p, ok := repoPath(a.Path)
	if !ok || diffPathHash(p) != hash {
		return "the file is not the one this thread is about"
	}
	if a.Side != "old" && a.Side != "new" {
		return "the side of the diff is old or new"
	}
	if a.StartLine < 1 || a.EndLine < a.StartLine || a.EndLine > 10_000_000 {
		return "the line range is not valid"
	}
	if len(a.Quote) > maxDiffQuote || len(a.Prefix) > maxDiffContext || len(a.Suffix) > maxDiffContext || strings.Count(a.Quote, "\n") >= maxDiffQuoteLines {
		return "the selected lines are too long to anchor a comment"
	}
	for _, t := range []string{a.Quote, a.Prefix, a.Suffix, a.Base} {
		if !utf8.ValidString(t) || strings.ContainsRune(t, 0) {
			return "the anchor is not valid text"
		}
	}
	if len(a.Base) > 200 {
		return "the base is too long"
	}
	ls, ok := h.diffSession(r, team, sid)
	if !ok {
		return "that agent is not running"
	}
	mode := h.getDiffMode(r.Context())
	if mode == "" {
		mode = "branch_point"
	}
	files, found, err := h.gs.GetChangedFiles(r.Context(), ls.AgentName, &sid, mode)
	if err != nil || !found {
		return "the agent's changed files are not known yet: open the Files panel and try again"
	}
	listed := false
	for _, f := range files {
		if f.Filepath == p {
			listed = true
			break
		}
	}
	if !listed {
		return "that file is not among the agent's changed files"
	}
	a.Whole = false
	a.Path = writeHidden(p)
	a.Base = cleanSendText(a.Base)
	for _, f := range []*string{&a.Quote, &a.Prefix, &a.Suffix} {
		if *f == "" {
			continue
		}
		out, ok := redactComment(*f)
		if !ok { // the lines could not be checked for secrets: the range and the path stand, the lines are not kept
			a.Quote, a.Prefix, a.Suffix, a.Withheld = "", "", "", true
			return ""
		}
		*f = out
	}
	return ""
}

// diffOwner is the board subscriber that is the session a diff key names, when it is a live one.
func (h *SessionsHandler) diffOwner(subs []board.Subscriber, sid string) (board.Subscriber, bool) {
	for _, s := range subs {
		if naming.SessionIDFromName(s.SessionName) == sid && s.IsActive != 0 {
			return s, true
		}
	}
	return board.Subscriber{}, false
}

// deliverDiffComment sends the Operator's comment c on a file of the agent's diff to that agent, as deliverGoalComment does for a goal: one board message from the Operator on the sendMessage path, a fixed
// frame with the comment as its only free text and the lines as quoted data, and the ask that lets the agent answer in this thread. Best effort: the comment is kept either way.
func (h *SessionsHandler) deliverDiffComment(r *http.Request, caller commentCaller, c store.ArtifactComment, id, team, sid, hash string) autoDelivery {
	if h.bs == nil || h.ss == nil {
		return autoDelivery{Reason: "failed"}
	}
	ctx := r.Context()
	if _, ok := h.diffSession(r, team, sid); !ok {
		return autoDelivery{Reason: "asleep_or_gone"}
	}
	subs, err := h.bs.ListSubscribers(ctx, team)
	if err != nil {
		return autoDelivery{Reason: "failed"}
	}
	owner, ok := h.diffOwner(subs, sid)
	if !ok {
		return autoDelivery{Reason: "asleep_or_gone"}
	}
	if h.boardHandler != nil && h.boardHandler.IsPaused(team) {
		return autoDelivery{Reason: "board_paused"}
	}
	if !h.sendLimit.allow(caller.Issuer+"|"+caller.Subject, time.Now()) {
		return autoDelivery{Reason: "rate_limited"}
	}
	title := cleanAgentName(owner.JobTitle)
	if title == "" {
		return autoDelivery{Reason: "no_uploader"}
	}
	rootID := c.ID
	if c.ParentID != nil {
		rootID = *c.ParentID
	}
	anchor := anchorOfComment(c)
	if anchor == nil && c.ParentID != nil { // a reply of the Operator's is about the thread's own lines
		if root, found, err := h.ss.GetArtifactComment(ctx, id, rootID); err == nil && found {
			anchor = anchorOfComment(root)
		}
	}
	if anchor == nil || anchor.Path == "" {
		return autoDelivery{Reason: "failed"}
	}
	text, ok1 := sendQuote(c.Body, 2*sendCommentCap)
	snippet := "(the lines are not quoted: they could not be checked for secrets)"
	ok2 := true
	if !anchor.Withheld {
		snippet, ok2 = sendQuote(anchor.Quote, sendSnippetCap)
	}
	if !ok1 || !ok2 {
		return autoDelivery{Reason: "redaction_unavailable"}
	}
	var names []string
	for _, s := range subs {
		names = append(names, s.SubscriberID)
		if tt := strings.TrimSpace(s.JobTitle); tt != "" {
			names = append(names, tt)
		}
	}
	if _, _, err := h.ss.CreateArtifactAsk(ctx, rootID, id, team, sid, title, time.Now()); err != nil {
		slog.Warn("[diff comments] ask not recorded", "error", err)
		return autoDelivery{Reason: "failed"}
	}
	lines := strconv.Itoa(anchor.StartLine)
	if anchor.EndLine > anchor.StartLine {
		lines += "-" + strconv.Itoa(anchor.EndLine)
	}
	side := "the new side"
	if anchor.Side == "old" {
		side = "the old side"
	}
	where := fmt.Sprintf("%s, lines %s on %s of your changes (%s)", cleanSendText(anchor.Path), lines, side, diffLink(team, sid, hash))
	msg := sendMessageOf(sendOnDiff, title, "the owner", where, sendReplyCommand(id, rootID), text, snippet, names, commentPictureLinks(c.ImagesJSON)...)
	if _, err := h.bs.PostDefusedMessage(ctx, team, board.OperatorName, msg); err != nil {
		slog.Warn("[diff comments] message not posted", "board", team, "error", err)
		_ = h.ss.CloseArtifactAsk(ctx, rootID, sid, time.Now())
		return autoDelivery{Reason: "failed"}
	}
	if h.boardHandler != nil && h.boardHandler.notifyFn != nil {
		h.boardHandler.notifyFn(team)
	}
	slog.Info("[diff comments] the Operator's comment sent to the agent", "board", team, "comment", c.ID, "agent", title)
	return autoDelivery{To: title}
}
