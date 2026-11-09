package routes

// Share via Dropbox, a board chat (#14944, Security's condition 6): one Markdown transcript of the messages the Operator chose, built HERE
// (never by the browser), previewed before anything leaves the computer, and shared exactly as previewed (its SHA-256 is checked again).
// Markdown since #14982: Dropbox's preview does not render an .html file (the Operator's walk), and the Operator chose .md. Every character of
// a message is escaped (escapeMarkdown); each message is redacted for secrets first (the credential rules, failing closed). Left out: Coral's own system
// posts, messages to a group only, and every id (session, subscriber, message, task); no images or attachments.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
)

const chatShareMaxMessages = 2000

// chatPage is a rendered chat transcript and what it holds.
type chatPage struct {
	text     []byte
	hash     string
	included int
	leftOut  int
}

// renderChatPage builds the transcript from the messages, in the order given, with sharedOn's date in its header: a Markdown file (.md), which
// Dropbox's preview shows (the Operator found it does not render an .html file, comment 372, and chose Markdown, #14982). Coral writes the
// only markup (the title and each message's heading); every character of a message, an author and the team is escaped (escapeMarkdown), so a
// message cannot make a link, an image, a heading, code, HTML or an entity: it shows as written, links as plain text. Control and format
// characters (bidi and zero-width included) are dropped first, then each message is redacted for secrets (failing closed), then escaped. Left out: Coral's own system posts, messages
// to a group only, and every id.
func renderChatPage(team string, msgs []*board.Message, sharedOn time.Time) (chatPage, error) {
	var page chatPage
	var body strings.Builder
	first, last := "", ""
	red := secrets.CredentialRedactor()
	for _, m := range msgs {
		if m == nil || m.IsSystem || m.TargetGroupID != nil {
			page.leftOut++
			continue
		}
		text, err := red.Text([]byte(chatBodyText(m.Content))) // control and format characters dropped BEFORE redacting: a key split by a zero-width character cannot slip past and rejoin (Security's INFO 6 on 44d03efa3)
		if err != nil {
			return chatPage{}, err
		}
		at := m.CreatedAt
		if t, err := time.Parse(time.RFC3339, at); err == nil {
			at = t.UTC().Format("2 Jan 2006 15:04 UTC")
		} else if len(at) > 16 {
			at = at[:16]
		}
		if first == "" {
			first = at
		}
		last = at
		author := m.JobTitle
		if author == "" {
			author = "Unknown"
		}
		fmt.Fprintf(&body, "### %s · %s\n\n%s\n\n", escapeMarkdown(plainText(author, 80)), escapeMarkdown(plainText(at, 40)), markdownLines(chatBodyText(string(text))))
		page.included++
	}
	if page.included == 0 {
		return chatPage{}, errors.New("nothing to share: every message chosen is left out")
	}
	span := first
	if last != first {
		span = first + " to " + last
	}
	words := "messages"
	if page.included == 1 {
		words = "message"
	}
	head := fmt.Sprintf("# %s\n\n%s\n\n---\n\n", escapeMarkdown(plainText(team, 60)+" chat"),
		escapeMarkdown(fmt.Sprintf("%s · %d %s · shared from Coral on %s. Secrets that looked like keys or tokens were removed.", span, page.included, words, sharedOn.UTC().Format("2 Jan 2006"))))
	page.text = []byte(head + strings.TrimRight(body.String(), "\n") + "\n")
	sum := sha256.Sum256(page.text)
	page.hash = hex.EncodeToString(sum[:])
	return page, nil
}

// plainText drops control and format characters (bidi included), puts a line on one line, and caps the length in characters.
func plainText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	if r := []rune(strings.TrimSpace(s)); len(r) > max {
		return string(r[:max]) + "…"
	}
	return strings.TrimSpace(s)
}

// escapeMarkdown puts a backslash before every ASCII punctuation character, which CommonMark (and Dropbox's preview) then shows as itself: no
// emphasis, link, image, autolink (the ':' and '.' of an address are escaped), code, heading, list, quote, table, HTML tag or entity can start.
func escapeMarkdown(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x80 && unicode.IsPunct(r) || r < 0x80 && unicode.IsSymbol(r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// markdownLines escapes a message's text and keeps its line breaks: each line ends in a hard break (two spaces), a blank line stays a new
// paragraph, and a line's leading spaces are kept as no-break spaces (they would otherwise make an indented code block).
func markdownLines(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lead := len(l) - len(strings.TrimLeft(l, " \t"))
		l = strings.Repeat("\u00a0", lead) + escapeMarkdown(l[lead:])
		if l != "" && i < len(lines)-1 && lines[i+1] != "" {
			l += "  "
		}
		lines[i] = l
	}
	return strings.Join(lines, "\n")
}

// chatBodyText is a message's text for the transcript: its lines as written (a tab kept), control and format characters dropped, Windows line
// ends made plain, and runs of blank lines kept to one.
func chatBodyText(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, strings.ReplaceAll(s, "\r\n", "\n"))
	for strings.Contains(s, "\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(s)
}

type chatShareRequest struct {
	IDs      []int64  `json:"ids"`
	Hash     string   `json:"hash"` // the preview's SHA-256: the page shared must be the one previewed
	Name     string   `json:"name"`
	Audience string   `json:"audience"`
	Emails   []string `json:"emails"`
	Expire   bool     `json:"expire"`
	Confirm  bool     `json:"confirm"`
}

// chatPageFor reads the chosen messages of the board and renders them. A message that is not on this board is refused (the page must be what
// was chosen).
func (b *DropboxBackup) chatPageFor(ctx context.Context, project string, ids []int64) (chatPage, int, string) {
	if b.chat == nil {
		return chatPage{}, http.StatusNotFound, "Sharing a chat is not available here"
	}
	if len(ids) == 0 || len(ids) > chatShareMaxMessages {
		return chatPage{}, http.StatusBadRequest, "Choose 1 to 2,000 messages"
	}
	seen := map[int64]bool{}
	msgs := make([]*board.Message, 0, len(ids))
	for _, id := range ids {
		if id < 1 || seen[id] {
			return chatPage{}, http.StatusBadRequest, "Each message once"
		}
		seen[id] = true
		m, err := b.chat(ctx, project, id)
		if err != nil || m == nil {
			return chatPage{}, http.StatusConflict, "A message chosen is no longer on this board; choose again"
		}
		msgs = append(msgs, m)
	}
	page, err := renderChatPage(project, msgs, b.clock())
	if err != nil {
		return chatPage{}, http.StatusUnprocessableEntity, "Could not make the page: " + err.Error()
	}
	if len(page.text) > dropboxObjectMax {
		return chatPage{}, http.StatusRequestEntityTooLarge, "The page is too big for Dropbox backup's size; choose fewer messages"
	}
	return page, http.StatusOK, ""
}

// DropboxShareChatPreview answers POST /api/dropbox/share-chat/{project}/preview {ids}: the page as it would be shared (for the dialog to show in
// a sandboxed frame), its SHA-256, and how many messages it holds and leaves out. Nothing leaves the computer.
func (h *CloudHandler) DropboxShareChatPreview(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok || !requireJSON(w, r) {
		return
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, "send {ids: [...]}")
		return
	}
	project := chi.URLParam(r, "project")
	page, code, msg := b.chatPageFor(r.Context(), project, in.IDs)
	if code != http.StatusOK {
		writeError(w, code, "chat", msg)
		return
	}
	out := map[string]any{"connected": false, "text": string(page.text), "hash": page.hash, "size": len(page.text),
		"included": page.included, "left_out": page.leftOut, "name": cleanShareName(project+" chat", ".md")}
	if cl, access, account, err := b.dropboxAccess(r.Context()); err == nil { // the dialog's choices: the team, and whether a link can expire
		if acct, err := cl.CurrentAccount(r.Context(), access); err == nil && acct.AccountID == account {
			out["connected"], out["team"], out["can_expire"] = true, acct.TeamName, !acct.Basic
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// DropboxShareChat answers POST /api/dropbox/share-chat/{project}: render the page again, refuse it unless its SHA-256 is the preview's, then
// share it as an artifact is shared (a copy in /Shared from Coral/<team>/, uploaded and checked, then people or a link).
func (h *CloudHandler) DropboxShareChat(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok || !requireJSON(w, r) {
		return
	}
	var in chatShareRequest
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, "not a share request")
		return
	}
	if !in.Confirm {
		writeError(w, http.StatusBadRequest, "confirm_required", "Sharing needs your press in the dialog")
		return
	}
	var emails []string
	switch in.Audience {
	case store.DropboxSharePeople:
		var err error
		if emails, err = shareEmails(in.Emails); err != nil {
			writeError(w, http.StatusBadRequest, "emails", err.Error())
			return
		}
	case store.DropboxShareTeam, store.DropboxSharePublic:
		if len(in.Emails) > 0 {
			errBadRequest(w, "a link is not shared with people by email")
			return
		}
	default:
		errBadRequest(w, "share with people, your team or anyone with the link")
		return
	}
	ctx := r.Context()
	project := chi.URLParam(r, "project")
	page, code, msg := b.chatPageFor(ctx, project, in.IDs)
	if code != http.StatusOK {
		writeError(w, code, "chat", msg)
		return
	}
	if in.Hash == "" || in.Hash != page.hash {
		writeError(w, http.StatusConflict, "changed", "The chat changed since the preview; open the preview again")
		return
	}
	name := cleanShareName(in.Name, ".md")
	if name == "" {
		writeError(w, http.StatusBadRequest, "name", "Give the file a name recipients will see")
		return
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		writeError(w, http.StatusConflict, "not_connected", "Connect Dropbox first")
		return
	}
	acct, err := cl.CurrentAccount(ctx, access)
	if err != nil || acct.AccountID != account {
		writeError(w, http.StatusBadGateway, "dropbox", "Could not read your Dropbox account; try again")
		return
	}
	if in.Audience == store.DropboxShareTeam && acct.TeamName == "" {
		writeError(w, http.StatusBadRequest, "no_team", "This Dropbox account is not in a team")
		return
	}
	var expires time.Time
	if in.Expire && !acct.Basic && in.Audience != store.DropboxSharePeople {
		expires = b.clock().Add(shareExpiry).UTC().Truncate(time.Second)
	}
	src := shareSource{data: page.text, name: name, ext: ".md", team: project, version: 1}
	res, code, refusal := b.share(ctx, cl, access, account, store.DropboxShareChat, "", src, name, in.Audience, emails, expires)
	if refusal != nil {
		writeJSON(w, code, refusal)
		return
	}
	delete(res, "version")
	if in.Expire && acct.Basic && in.Audience != store.DropboxSharePeople {
		res["expiry"] = "Expiry is not available on this Dropbox plan: the link does not expire until you stop sharing" // said, not silently none (QA's INFO 6)
	}
	res["included"] = page.included
	writeJSON(w, http.StatusOK, res)
}
