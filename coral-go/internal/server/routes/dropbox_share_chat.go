package routes

// Share via Dropbox, a board chat (#14944, Security's condition 6): one self-contained HTML page of the messages the Operator chose, built HERE
// (never by the browser), previewed before anything leaves the computer, and shared exactly as previewed (its SHA-256 is checked again).
//
// The page: no script, no event handler, no outside request, under a CSP meta (default-src 'none'; style-src 'unsafe-inline'). Every word an
// agent, a guest or a person wrote is escaped; the formatting kept is paragraphs, line breaks, fenced and inline code; links are text, never
// anchors; no images or attachments (named in the text only). Each message is redacted for secrets first (the credential rules, failing closed).
// Left out: Coral's own system posts, messages to a group only, and every id (session, subscriber, message, task).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
)

const (
	chatShareMaxMessages = 2000
	chatPageCSP          = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
)

// chatPage is a rendered chat page and what it holds.
type chatPage struct {
	html     []byte
	hash     string
	included int
	leftOut  int
}

// renderChatPage builds the page from the messages, in the order given, with sharedOn's date in its header. It fails closed when a message
// cannot be checked for secrets.
func renderChatPage(team string, msgs []*board.Message, sharedOn time.Time) (chatPage, error) {
	var page chatPage
	var body bytes.Buffer
	first, last := "", ""
	red := secrets.CredentialRedactor()
	for _, m := range msgs {
		if m == nil || m.IsSystem || m.TargetGroupID != nil {
			page.leftOut++
			continue
		}
		text, err := red.Text([]byte(m.Content))
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
		fmt.Fprintf(&body, "<article><header><b>%s</b> <time>%s</time></header>%s</article>\n",
			html.EscapeString(plainText(author, 80)), html.EscapeString(at), formatChatText(string(text)))
		page.included++
	}
	if page.included == 0 {
		return chatPage{}, errors.New("nothing to share: every message chosen is left out")
	}
	span := first
	if last != first {
		span = first + " to " + last
	}
	var out bytes.Buffer
	fmt.Fprintf(&out, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="%s">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>%s</title>
<style>
body{margin:0 auto;max-width:860px;padding:16px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1d1f23;background:#fff}
h1{font-size:20px;margin:0 0 4px}.meta{color:#5b6070;margin:0 0 20px;font-size:13px}
article{border-top:1px solid #e3e5ea;padding:10px 0}article header{margin-bottom:4px}time{color:#5b6070;font-size:12px;margin-left:6px}
p{margin:0 0 8px;overflow-wrap:anywhere}pre{background:#f4f5f7;padding:8px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
code{background:#f4f5f7;padding:0 3px;border-radius:3px;font-size:13px}pre code{padding:0;background:none}
@media (prefers-color-scheme: dark){body{color:#e6e7ea;background:#16171b}article{border-color:#30333b}.meta,time{color:#9a9ea8}pre,code{background:#22252c}}
</style></head><body>
<h1>%s</h1>
<p class="meta">%s · %d %s · shared from Coral on %s. Secrets that looked like keys or tokens were removed.</p>
%s</body></html>
`, chatPageCSP, html.EscapeString("Coral chat: "+plainText(team, 60)), html.EscapeString(plainText(team, 60)+" chat"), html.EscapeString(span),
		page.included, map[bool]string{true: "message", false: "messages"}[page.included == 1], sharedOn.UTC().Format("2 Jan 2006"), body.String())
	page.html = out.Bytes()
	sum := sha256.Sum256(page.html)
	page.hash = hex.EncodeToString(sum[:])
	return page, nil
}

// plainText drops control and format characters (bidi included) and caps the length in characters.
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

// formatChatText turns a message into escaped HTML: ``` fences become <pre><code>, blank lines split paragraphs, a line break is <br>, `x` is
// <code>. Nothing else is markup: every character of the text is escaped, so a tag, an event handler or a javascript: link is shown as text.
func formatChatText(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, strings.ReplaceAll(s, "\r\n", "\n"))
	var out strings.Builder
	parts := strings.Split(s, "```")
	for i, part := range parts {
		if i%2 == 1 && i < len(parts)-1 { // inside a closed fence: drop the language word on its first line
			if nl := strings.IndexByte(part, '\n'); nl >= 0 && !strings.ContainsAny(part[:nl], " \t") {
				part = part[nl+1:]
			}
			out.WriteString("<pre><code>" + html.EscapeString(strings.TrimRight(part, "\n")) + "</code></pre>")
			continue
		}
		if i%2 == 1 { // an unclosed fence: its text is plain text
			part = "```" + part
		}
		for _, para := range strings.Split(part, "\n\n") {
			para = strings.Trim(para, "\n")
			if strings.TrimSpace(para) == "" {
				continue
			}
			lines := strings.Split(para, "\n")
			for j, l := range lines {
				lines[j] = inlineCode(l)
			}
			out.WriteString("<p>" + strings.Join(lines, "<br>") + "</p>")
		}
	}
	return out.String()
}

// inlineCode escapes a line and wraps each `pair` in <code>.
func inlineCode(l string) string {
	segs := strings.Split(l, "`")
	var b strings.Builder
	for i, seg := range segs {
		e := html.EscapeString(seg)
		switch {
		case i%2 == 1 && i < len(segs)-1:
			b.WriteString("<code>" + e + "</code>")
		case i%2 == 1:
			b.WriteString("`" + e)
		default:
			b.WriteString(e)
		}
	}
	return b.String()
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
	if len(page.html) > dropboxObjectMax {
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
	out := map[string]any{"connected": false, "html": string(page.html), "hash": page.hash, "size": len(page.html),
		"included": page.included, "left_out": page.leftOut, "name": cleanShareName(project+" chat", ".html")}
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
	name := cleanShareName(in.Name, ".html")
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
	src := shareSource{data: page.html, name: name, ext: ".html", team: project, version: 1}
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
