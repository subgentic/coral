package routes

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Send to agent with the diff (#13802, #13791): after the Operator saves an edit of a team's Markdown file in the dashboard editor, Send tells chosen agents what changed. The request carries recipient NAMES only;
// the server makes the diff itself, from the stored Operator version and its immediate predecessor in the same team and series, and delivers it through the machinery of a comment on an artifact: one root
// comment on the edited version (made on the first explicit Send, reused after), one ask row per agent so the agent can reply into the thread, one board message from the Operator with the diff as untrusted
// quoted data. Nothing is sent on its own: only this click.
//
//	GET  /api/board/{project}/artifacts/{digest}/edit/send   {can_send_edit, base_digest, base_version, version, sent_to:[roles], thread_id}: whether Send is offered and who already has it
//	POST /api/board/{project}/artifacts/{digest}/edit/send   {agents:[roles]}                        the sends: results per agent, thread_id, version, previous_version, limited, already_sent

const (
	editSendDiffCap   = 1 << 10 // bytes of the complete cleaned diff; over it the message carries a note and both links instead (a hunk is never cut)
	editSendThreadTag = "Send to agent: the Operator's edit of this file (version %d). The text below is the Operator's own record of what the thread is about; the agents' replies follow."
)

// editSendLocks serialise the making of the one root comment of an edited version (the store has no unique key for it): a lock per first byte of the digest, as the series locks are.
var editSendLocks [256]sync.Mutex

func lockEditSend(digest string) func() {
	var i byte
	if len(digest) >= 2 {
		if b, err := hexByte(digest[0], digest[1]); err == nil {
			i = b
		}
	}
	editSendLocks[i].Lock()
	return editSendLocks[i].Unlock
}

var sendOnEdit = sendKind{what: "the Operator's edit of a file", context: "Edited version", snippetLabel: "the version before the edit"}

// editSendTarget is the edit a send is for: the stored Operator version and the version just before it in the same team and series.
type editSendTarget struct {
	project, digest, prev string
	version               int
	name                  string
}

// editSendTargetOf finds the edit; ok false means the answer is written (404 for a file this team does not have, 409 not_an_edit for one that is not an Operator editor save with a predecessor).
func (h *SessionsHandler) editSendTargetOf(w http.ResponseWriter, project, digest string) (editSendTarget, bool) {
	var t editSendTarget
	if !editDigestRe.MatchString(digest) {
		errBadRequest(w, "the artifact is named by its 64-hex digest")
		return t, false
	}
	coralDir := h.cfg.CoralDir()
	sid, _, in := digestSeries(coralDir, digest)
	if !in {
		commentRefuse(w, http.StatusConflict, "not_an_edit", "this version is not a saved edit of the Operator")
		return t, false
	}
	ms := seriesMembers(coralDir, sid)
	if len(ms) == 0 || ms[0].Board != project {
		errNotFound(w, "this team has no such file")
		return t, false
	}
	at := -1
	for i, m := range ms {
		if m.Digest == digest {
			at = i
		}
	}
	if at < 0 {
		errNotFound(w, "this team has no such file")
		return t, false
	}
	if ms[at].Source != sourceOperatorEdit || at == 0 {
		commentRefuse(w, http.StatusConflict, "not_an_edit", "this version is not a saved edit of the Operator")
		return t, false
	}
	t = editSendTarget{project: project, digest: digest, prev: ms[at-1].Digest, version: ms[at].N}
	if rec, ok := readUploadRecord(coralDir, ms[at].Session, digest); ok {
		t.name = rec.Name
	}
	return t, true
}

// editSendOwner is the gate both routes begin with (Security's conditions): through Coral Hub the owner's alone, on this computer a person; the POST is from this server's own page unless a genuine stamp or an
// authentic tunnel stands for it (the Hub carries no browser headers).
func (h *SessionsHandler) editSendOwner(w http.ResponseWriter, r *http.Request, write bool) (commentCaller, bool) {
	if cloud.Tunneled(r) && refuseNonOwner(w, r) {
		return commentCaller{}, false
	}
	if r.Header.Get(tunnel.ViaHeader) != "" && !cloud.TunneledAuthentic(r) {
		commentRefuse(w, http.StatusForbidden, "forged_tunnel_stamp", "not allowed")
		return commentCaller{}, false
	}
	caller, status, code := h.artifactCommentCaller(r)
	if status != 0 {
		commentRefuse(w, status, code, "not allowed")
		return commentCaller{}, false
	}
	if write {
		if caller.Kind != commentCallerOwner || !humanInputCaller(r) {
			commentRefuse(w, http.StatusForbidden, "owner_only", "only the person at this computer can send an edit to an agent")
			return commentCaller{}, false
		}
		kind, _ := r.Context().Value(callerKindKey{}).(string)
		hubCaller := kind == callerHubOwner || (kind == callerHub && cloud.TunneledAuthentic(r))
		if !hubCaller && !sameOriginFetch(r) {
			commentRefuse(w, http.StatusForbidden, "cross_site", "an edit is sent from this server's own page")
			return commentCaller{}, false
		}
		h.keepOwnerSubject(r.Context(), &caller)
	} else if caller.Kind != commentCallerOwner && !operatorOrKeyCaller(r) {
		commentRefuse(w, http.StatusForbidden, "owner_only", "only the person at this computer can send an edit to an agent")
		return commentCaller{}, false
	}
	return caller, true
}

// editRootThread finds the one root comment of an edited version, or makes it. Under the per-digest lock, so two clicks make one.
func (h *SessionsHandler) editRootThread(r *http.Request, caller commentCaller, t editSendTarget, create bool) (store.ArtifactComment, bool) {
	marker := fmt.Sprintf(editSendThreadTag, t.version)
	cs, err := h.ss.ListArtifactComments(r.Context(), t.digest, "", []string{t.project})
	if err == nil {
		for _, c := range cs {
			if c.ParentID == nil && c.DeletedAt == nil && c.Body == marker && c.AuthorKind == commentCallerOwner { // the owner's own root, not deleted: an agent's or a viewer's comment with the same words is not the thread
				return c, true
			}
		}
	}
	if !create || err != nil {
		return store.ArtifactComment{}, false
	}
	c, err := h.ss.CreateArtifactComment(r.Context(), store.ArtifactComment{ArtifactID: t.digest, Board: t.project, AnchorJSON: `{"whole":true}`, Body: marker,
		AuthorIssuer: caller.Issuer, AuthorSubject: caller.Subject, AuthorName: caller.Name, AuthorKind: caller.Kind})
	if err != nil {
		slog.Warn("[edit send] the thread was not made", "error", err)
		return store.ArtifactComment{}, false
	}
	if h.bs != nil {
		h.bs.NoteAllArtifactsChanged()
	}
	return c, true
}

// editSendDiff is the complete cleaned diff of the edit, or why there is none. text is "" when the diff must not be shown (limited): too big to compare, nothing visible as lines, or over the cap.
func (h *SessionsHandler) editSendDiff(t editSendTarget) (text string, limited bool, redactionDown bool) {
	dir := filepath.Join(h.cfg.CoralDir(), "artifacts", "objects")
	read := func(d string) (string, bool) {
		f, err := os.Open(filepath.Join(dir, d))
		if err != nil {
			return "", false
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, maxMarkdownEdit+1)) // an object may be an agent's 64 MiB file: never read past the editor's limit
		if err != nil || len(b) > maxMarkdownEdit || !utf8.Valid(b) {
			return "", false
		}
		return string(b), true
	}
	oldText, ok1 := read(t.prev)
	newText, ok2 := read(t.digest)
	if !ok1 || !ok2 {
		return "", true, false
	}
	hunks, ok := unifiedHunks(oldText, newText)
	if !ok || hunks == "" {
		return "", true, false
	}
	// redacted first, as a whole, then cleaned: a cut after redacting cannot walk a secret's boundary, and none is made (a diff over the cap is not shown at all)
	clean, ok := sendQuoteLines(hunks, 1<<20)
	if !ok {
		return "", false, true
	}
	if len(clean) > editSendDiffCap {
		return "", true, false
	}
	return clean, false, false
}

type editSendIn struct {
	Agents []string `json:"agents"`
}

// GET /api/board/{project}/artifacts/{digest}/edit/send
func (h *SessionsHandler) getEditSend(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.editSendOwner(w, r, false); !ok {
		return
	}
	t, ok := h.editSendTargetOf(w, chi.URLParam(r, "project"), strings.ToLower(chi.URLParam(r, "digest")))
	if !ok {
		return
	}
	out := map[string]any{"can_send_edit": true, "base_digest": t.prev, "version": t.version, "base_version": 0, "sent_to": []string{}, "thread_id": 0}
	if sid, _, in := digestSeries(h.cfg.CoralDir(), t.digest); in {
		for _, m := range seriesMembers(h.cfg.CoralDir(), sid) {
			if m.Digest == t.prev {
				out["base_version"] = m.N
			}
		}
	}
	if root, found := h.editRootThread(r, commentCaller{}, t, false); found {
		out["thread_id"] = root.ID
		sent := []string{}
		if subs, err := h.bs.ListSubscribers(r.Context(), t.project); err == nil && h.ss != nil {
			lives, _ := h.ss.GetAllLiveSessions(r.Context())
			bySession := map[string]store.LiveSession{}
			for _, ls := range lives {
				bySession[naming.SessionName(ls.AgentType, ls.SessionID)] = ls
			}
			for _, s := range subs {
				if ls, live := bySession[s.SessionName]; live {
					if _, has, _ := h.ss.GetArtifactAsk(r.Context(), root.ID, ls.SessionID); has {
						sent = append(sent, cleanAgentName(s.JobTitle))
					}
				}
			}
		}
		out["sent_to"] = sent
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/board/{project}/artifacts/{digest}/edit/send {agents: [roles]}
func (h *SessionsHandler) sendEditDiff(w http.ResponseWriter, r *http.Request) {
	caller, ok := h.editSendOwner(w, r, true)
	if !ok {
		return
	}
	if !h.sendLimit.allow(caller.Issuer+"|"+caller.Subject, time.Now()) { // a refused or failed send counts too
		httputil.WriteActionLimit(w, 60, "rate_limited", "too many comments sent to agents; try again later")
		return
	}
	project := chi.URLParam(r, "project")
	var in editSendIn
	if !readJSONBody(w, r, sendBodyMax, &in) {
		return
	}
	var names []string
	seen := map[string]bool{}
	for _, a := range in.Agents {
		n := cleanSendText(a)
		if n == "" || len(n) > 64 {
			errBadRequest(w, "each agent is a name the board knows")
			return
		}
		if k := strings.ToLower(n); !seen[k] {
			seen[k] = true
			names = append(names, n)
		}
	}
	if len(names) == 0 || len(names) > sendMaxAgents {
		errBadRequest(w, fmt.Sprintf("name between 1 and %d agents", sendMaxAgents))
		return
	}
	t, ok := h.editSendTargetOf(w, project, strings.ToLower(chi.URLParam(r, "digest")))
	if !ok {
		return
	}
	if h.bs == nil || h.ss == nil {
		errInternalServer(w, "the message board is not available")
		return
	}
	if h.boardHandler != nil && h.boardHandler.IsPaused(project) {
		commentRefuse(w, http.StatusConflict, "board_paused", "the board is paused: nothing is sent to its agents until it is resumed")
		return
	}
	diff, limited, redactionDown := h.editSendDiff(t)
	if redactionDown {
		commentRefuse(w, http.StatusServiceUnavailable, "redaction_unavailable", "the change could not be checked for secrets, so it was not sent")
		return
	}
	unlock := lockEditSend(t.digest)
	defer unlock()
	root, ok := h.editRootThread(r, caller, t, true)
	if !ok {
		errInternalServer(w, "could not make the thread")
		return
	}
	subs, err := h.bs.ListSubscribers(r.Context(), project)
	if err != nil {
		errInternalServer(w, "could not read the board")
		return
	}
	var mentionNames []string
	for _, s := range subs {
		mentionNames = append(mentionNames, s.SubscriberID)
		if tt := strings.TrimSpace(s.JobTitle); tt != "" {
			mentionNames = append(mentionNames, tt)
		}
	}
	prevLink, newLink := "coral://artifacts/"+t.prev, "coral://artifacts/"+t.digest
	version := fmt.Sprintf("%s (the Operator's edit, version %d; the version before it: %s)", newLink, t.version, prevLink)
	lives, _ := h.ss.GetAllLiveSessions(r.Context())
	bySession := map[string]store.LiveSession{}
	for _, ls := range lives {
		bySession[naming.SessionName(ls.AgentType, ls.SessionID)] = ls
	}
	results := make([]sendResult, 0, len(names))
	alreadySent := []string{}
	sent := 0
	shownAsNote := limited // the diff was not shown (too big, not lines, or it did not fit the delivery cap with its frame)
	for _, name := range names {
		res := sendResult{Agent: name}
		var sub *board.Subscriber
		for i := range subs {
			if strings.EqualFold(cleanAgentName(subs[i].JobTitle), name) {
				sub = &subs[i]
				break
			}
		}
		var ls store.LiveSession
		live := false
		if sub != nil {
			ls, live = bySession[sub.SessionName]
		}
		if live {
			if ask, has, _ := h.ss.GetArtifactAsk(r.Context(), root.ID, ls.SessionID); has { // this version was sent to this agent already (kept after the ask ended or was answered): idempotent, and no wake-up
				res.State, res.AskID = "already_sent", ask.ID
				alreadySent = append(alreadySent, name)
				results = append(results, res)
				continue
			}
		}
		if live && ls.IsSleeping == 1 && sleepReason(ls) == store.SleepReasonIdle && h.WakeIdleForDelivery(r.Context(), ls.SessionID) {
			ls.IsSleeping = 0
		}
		switch {
		case sub == nil:
			res.State = "not_on_board"
		case !live || ls.IsArchived == 1 || ls.AgentType == "terminal":
			res.State = "unavailable"
		case ls.IsSleeping == 1:
			res.State, res.Reason = "asleep", "it is asleep: wake it first"
		default:
			title := cleanAgentName(sub.JobTitle)
			ask, _, err := h.ss.CreateArtifactAsk(r.Context(), root.ID, t.digest, project, ls.SessionID, title, time.Now())
			if err != nil {
				slog.Warn("[edit send] ask not recorded", "error", err)
				res.State = "failed"
				break
			}
			body, noted := editSendBody(sendBuilder(sendOnEdit, title, "the authors of the file", version, sendReplyCommand(t.digest, root.ID), "", mentionNames, nil), diff, limited, prevLink, newLink)
			shownAsNote = shownAsNote || noted
			if err := h.postEditMessage(r.Context(), project, body); err != nil {
				slog.Warn("[edit send] message not posted", "board", project, "error", err)
				_ = h.ss.DeleteArtifactAsk(r.Context(), root.ID, ls.SessionID) // no row is left: a retry is a first send, not "already sent" for an agent that never got it (QA)
				res.State = "failed"
				break
			}
			res.State, res.AskID = "sent", ask.ID
			sent++
			slog.Info("[edit send] an edit sent to an agent", "surface", "local", "artifact", t.digest, "thread", root.ID, "agent", title, "board", project) // who, where, what: never the text
		}
		results = append(results, res)
	}
	if h.boardHandler != nil && h.boardHandler.notifyFn != nil && sent > 0 {
		h.boardHandler.notifyFn(project)
	}
	status := http.StatusOK
	if sent == 0 && len(alreadySent) == 0 {
		status = http.StatusConflict
	}
	if sent > 0 {
		noteActivity(r, board.ActFileEditSend, "file", t.digest, project, t.name, fmt.Sprintf("to %d agent(s)", sent))
	}
	out := map[string]any{"ok": sent > 0 || status == http.StatusOK, "results": results, "thread_id": root.ID, "version": t.version, "previous_version": t.version - 1, "limited": shownAsNote, "already_sent": alreadySent}
	if status == http.StatusConflict {
		out["code"], out["error"] = "nothing_sent", "nothing was sent: the agents named are not available"
	}
	writeJSON(w, status, out)
}

// editSendBody is the whole message to one agent: the complete diff when it fits the delivery cap with its frame, else the limit note and both version links (never a part of the diff). noted says the note was used.
func editSendBody(build func(c string) string, diff string, limited bool, prevLink, newLink string) (msg string, noted bool) {
	if !limited && diff != "" {
		if m := build(diff); len(m) <= sendMessageCap {
			return m, false
		}
	}
	note := fmt.Sprintf("The change is too large to show here, or cannot be shown as lines. Read both versions yourself (coral-agent artifact download <link>): the version before: %s ; the Operator's edit: %s .", prevLink, newLink)
	return build(note), true
}

// RegisterEditSend adds the two routes of Send to agent with the diff. They are board routes: the server registers them in the group that answers 503 when the board store is not open.
func (h *SessionsHandler) RegisterEditSend(r chi.Router) {
	r.Get("/api/board/{project}/artifacts/{digest}/edit/send", h.getEditSend)                          // is Send offered for this saved edit, and who already has it
	r.With(RefuseSignInLink).Post("/api/board/{project}/artifacts/{digest}/edit/send", h.sendEditDiff) // the send: names only; the server makes the diff
}

// postEditMessage posts the Operator's message to the board (a seam of the handler for a test that makes the post fail).
func (h *SessionsHandler) postEditMessage(ctx context.Context, project, body string) error {
	if h.editPost != nil {
		return h.editPost(ctx, project, body)
	}
	_, err := h.bs.PostDefusedMessage(ctx, project, board.OperatorName, body)
	return err
}
