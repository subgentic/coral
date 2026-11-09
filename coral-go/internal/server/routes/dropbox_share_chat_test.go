package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// Share via Dropbox, a chat page (#14944, Security's condition 6). Each test names the mutant it fails against.

func chatMsg(id int64, who, text string) *board.Message {
	return &board.Message{ID: id, Project: "team-a", SubscriberID: "sub-" + who, JobTitle: who, Content: text, CreatedAt: "2026-11-09T10:0" + string(rune('0'+id%10)) + ":00Z"}
}

// fakeToken is an AWS-key-shaped id built at run time, as the secrets tests build theirs (no secret-looking literal in the repository).
func fakeToken() string {
	const upperNum = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	var b strings.Builder
	x := uint32(7)
	for i := 0; i < 16; i++ {
		x = x*1664525 + 1013904223
		b.WriteByte(upperNum[int(x>>24)%len(upperNum)])
	}
	return "AKIA" + b.String()
}

func hostileMessages() []*board.Message {
	group := "g1"
	return []*board.Message{
		chatMsg(1, "Lead", "Plan:\n\n<script>alert(1)</script> and <img src=x onerror=alert(2)> and [click](javascript:alert(3))"),
		chatMsg(2, "QA <b>Bold</b>", "token "+fakeToken()+" here\n```go\nfmt.Println(\"<x>\")\n```\nand `inline <y>` code\u202e reversed"),
		chatMsg(3, "Long", strings.Repeat("x", 5000)),
		{ID: 4, Project: "team-a", JobTitle: "Coral Task Queue", Content: "[Task #9] system post", CreatedAt: "2026-11-09T10:04:00Z", IsSystem: true},
		{ID: 5, Project: "team-a", JobTitle: "Lead", Content: "to the group only", CreatedAt: "2026-11-09T10:05:00Z", TargetGroupID: &group},
	}
}

// #14982 (the Operator's walk: Dropbox does not render .html; the Operator chose .md): the chat is a Markdown transcript where Coral writes the only
// markup. Mutants: a message's punctuation is not escaped (a link, image, tag, autolink or code fence would render); secrets are not redacted;
// system or group posts are included; an id is printed; a format character (bidi) is kept.
func TestTheChatTranscriptIsEscapedMarkdownRedactedAndComplete(t *testing.T) {
	page, err := renderChatPage("team-a", hostileMessages(), time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	s := string(page.text)
	assert.True(t, strings.HasPrefix(s, "# team\\-a chat\n\n9 Nov 2026 10\\:01 UTC to 9 Nov 2026 10\\:03 UTC · 3 messages · shared from Coral on 9 Nov 2026\\. Secrets"), s[:160])
	assert.Contains(t, s, "### Lead · 9 Nov 2026 10\\:01 UTC\n\nPlan\\:\n\n\\<script\\>alert\\(1\\)\\<\\/script\\> and \\<img src\\=x onerror\\=alert\\(2\\)\\> and \\[click\\]\\(javascript\\:alert\\(3\\)\\)\n",
		"a tag, an image and a link are escaped: they show as written")
	assert.Contains(t, s, "### QA \\<b\\>Bold\\<\\/b\\> · ")
	assert.Contains(t, s, "\\`\\`\\`go  \nfmt\\.Println\\(\\\"\\<x\\>\\\"\\)  \n\\`\\`\\`", "a code fence is escaped, its lines kept")
	assert.NotContains(t, s, "\u202e", "format characters are dropped")
	assert.NotContains(t, s, fakeToken(), "the token is redacted")
	assert.NotContains(t, s, "system post")
	assert.NotContains(t, s, "group only")
	for _, id := range []string{"sub\\-Lead", "sub\\-QA", "Task \\#9"} {
		assert.NotContains(t, s, id)
	}
	assert.Equal(t, 3, page.included)
	assert.Equal(t, 2, page.leftOut)
	sum := sha256.Sum256(page.text)
	assert.Equal(t, hex.EncodeToString(sum[:]), page.hash)

	// Every ASCII punctuation character of a message is escaped: none is left bare in the message's part of the file.
	evil := "**bold** _x_ ![img](http://e.example/i.png) <a href=x>y</a> https://e.example www.e.example &amp; `c` # h\n> quote\n- item\n1. one\n| t | u |\n    indented"
	page, err = renderChatPage("t", []*board.Message{chatMsg(1, "A", evil)}, time.Now())
	require.NoError(t, err)
	msg := string(page.text)[strings.Index(string(page.text), "### A · "):]
	msg = msg[strings.Index(msg, "\n\n")+2:]
	for i := 0; i < len(msg); i++ {
		c := msg[i]
		if c < 0x80 && strings.ContainsRune("!\"#$%&'()*+,-./:;<=>?@[]^_`{|}~", rune(c)) {
			require.True(t, i > 0 && msg[i-1] == '\\', "%q bare at %d in %q", c, i, msg)
		}
		if c == '\\' {
			i++ // the escape and the character it escapes
		}
	}
	assert.Contains(t, msg, "\u00a0\u00a0\u00a0\u00a0indented", "leading spaces kept as no-break spaces, not an indented code block")

	_, err = renderChatPage("team-a", hostileMessages()[3:], time.Now())
	assert.Error(t, err, "nothing left to share")
}

func (be *backupEnv) chatCall(path, body string) (int, map[string]any) {
	be.t.Helper()
	r := chi.NewRouter()
	r.Post("/api/dropbox/share-chat/{project}/preview", be.h.DropboxShareChatPreview)
	r.Post("/api/dropbox/share-chat/{project}", be.h.DropboxShareChat)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	dashboardRequest(req)
	req.Host = be.host
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	return rec.Code, m
}

// Mutants: the share skips the hash check (a page changed since the preview is shared); a message of another board is taken; the page is not the
// preview's bytes in Dropbox.
func TestAChatIsSharedExactlyAsPreviewed(t *testing.T) {
	be, _ := newDropboxShareEnv(t)
	msgs := map[int64]*board.Message{}
	for _, m := range hostileMessages() {
		msgs[m.ID] = m
	}
	be.b.chat = func(_ context.Context, project string, id int64) (*board.Message, error) {
		if m, ok := msgs[id]; ok && project == m.Project {
			return m, nil
		}
		return nil, errors.New("not found")
	}
	code, prev := be.chatCall("/api/dropbox/share-chat/team-a/preview", `{"ids":[1,2,3,4,5]}`)
	require.Equal(t, http.StatusOK, code, "%v", prev)
	assert.EqualValues(t, 3, prev["included"])
	assert.EqualValues(t, 2, prev["left_out"])
	assert.Equal(t, true, prev["connected"])
	assert.Equal(t, true, prev["can_expire"])
	hash, _ := prev["hash"].(string)
	assert.Empty(t, be.sharedPaths(), "a preview sends nothing")

	code, out := be.chatCall("/api/dropbox/share-chat/other-team/preview", `{"ids":[1]}`)
	assert.Equal(t, http.StatusConflict, code, "%v", out)

	code, out = be.chatCall("/api/dropbox/share-chat/team-a", `{"ids":[1,2,3,4,5],"hash":"`+strings.Repeat("0", 64)+`","name":"x","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "changed", out["code"])

	msgs[1] = chatMsg(1, "Lead", "edited since the preview")
	code, out = be.chatCall("/api/dropbox/share-chat/team-a", `{"ids":[1,2,3,4,5],"hash":"`+hash+`","name":"x","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusConflict, code, "the page changed: %v", out)
	msgs[1] = hostileMessages()[0]

	code, out = be.chatCall("/api/dropbox/share-chat/team-a", `{"ids":[1,2,3,4,5],"hash":"`+hash+`","name":"Team A chat","audience":"public","confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	paths := be.sharedPaths()
	require.Len(t, paths, 1)
	assert.Equal(t, shareRoot+"/team-a/Team A chat.md", paths[0])
	be.dbx.mu.Lock()
	got := be.dbx.files[paths[0]]
	be.dbx.mu.Unlock()
	sum := sha256.Sum256(got)
	assert.Equal(t, hash, hex.EncodeToString(sum[:]), "Dropbox has the previewed bytes")
	n, _ := be.b.outbox.SharedCount(context.Background())
	assert.Equal(t, 1, n)
}
