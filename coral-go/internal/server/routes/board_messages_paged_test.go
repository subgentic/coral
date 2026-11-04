package routes

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13188: messages/all stays a bare array; ?paged=1 answers {messages, total, has_more, next_cursor}, the newest page first and the cursor going back.
func TestMessagesAllPagedIsOptInAndWalksBackWithoutGapsOrRepeats(t *testing.T) {
	server, _ := setupBoardTestServer(t)
	base := server.URL + "/api/board/pagedboard"
	resp := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Lead Developer"})
	resp.Body.Close()
	const n = 25
	for i := 0; i < n; i++ {
		resp = postJSON(t, base+"/messages", map[string]string{"subscriber_id": "Lead", "content": fmt.Sprintf("message %02d", i)})
		require.Equal(t, http.StatusOK, resp.StatusCode)
		resp.Body.Close()
	}
	get := func(q string) (int, []byte) {
		r, err := http.Get(base + "/messages/all" + q)
		require.NoError(t, err)
		defer r.Body.Close()
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			k, e := r.Body.Read(buf)
			b.Write(buf[:k])
			if e != nil {
				break
			}
		}
		return r.StatusCode, []byte(b.String())
	}

	// Without the parameter: the bare array, as always.
	code, raw := get("?limit=10")
	require.Equal(t, 200, code)
	var bare []map[string]any
	require.NoError(t, json.Unmarshal(raw, &bare), "still a bare array")
	assert.Len(t, bare, 10)

	type page struct {
		Messages   []struct{ Content string } `json:"messages"`
		Total      int                        `json:"total"`
		HasMore    bool                       `json:"has_more"`
		NextCursor string                     `json:"next_cursor"`
	}
	seen := map[string]bool{}
	q, pages := "?paged=1&limit=10", 0
	var order []string
	for {
		code, raw = get(q)
		require.Equal(t, 200, code, string(raw))
		var p page
		require.NoError(t, json.Unmarshal(raw, &p))
		pages++
		assert.Equal(t, n, p.Total)
		for _, m := range p.Messages {
			require.False(t, seen[m.Content], "sent once: "+m.Content)
			seen[m.Content] = true
			order = append(order, m.Content)
		}
		if pages == 1 {
			require.Len(t, p.Messages, 10)
			assert.Equal(t, "message 24", p.Messages[len(p.Messages)-1].Content, "the newest page first, oldest first inside it, as the bare list")
		}
		if !p.HasMore {
			assert.Empty(t, p.NextCursor)
			break
		}
		require.NotEmpty(t, p.NextCursor)
		q = "?paged=1&limit=10&cursor=" + p.NextCursor
		require.Less(t, pages, 10)
	}
	assert.Len(t, seen, n)
	assert.Equal(t, 3, pages)

	for _, bad := range []string{"?paged=2", "?paged=1&limit=0", "?paged=1&limit=501", "?paged=1&cursor=!!!", "?paged=1&cursor=" + strings.Repeat("A", 1100), "?paged=1&task_id=1", "?paged=1&id=1", "?paged=1&for_subscriber=Lead", "?paged=1&offset=5", "?paged=1&extra=1", "?paged=1&paged=1"} {
		code, _ = get(bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

// QA's table of the documented 400s of messages/all?paged=1 (#13188): each is refused, none ignored.
func TestMessagesAllPagedRefusesEveryDocumentedBadRequest(t *testing.T) {
	server, _ := setupBoardTestServer(t)
	base := server.URL + "/api/board/pagedbad"
	resp := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Lead Developer"})
	resp.Body.Close()
	resp = postJSON(t, base+"/messages", map[string]string{"subscriber_id": "Lead", "content": "one"})
	resp.Body.Close()
	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	cases := map[string]string{
		"id":                   "?paged=1&id=1",
		"task_id":              "?paged=1&task_id=1",
		"for_subscriber":       "?paged=1&for_subscriber=Lead",
		"offset":               "?paged=1&offset=1",
		"before_id":            "?paged=1&before_id=5",
		"after_id":             "?paged=1&after_id=0",
		"format":               "?paged=1&format=dashboard",
		"paged other value":    "?paged=0",
		"cursor over 1024":     "?paged=1&cursor=" + b64("b:"+strings.Repeat("9", 1100)),
		"no b: prefix":         "?paged=1&cursor=" + b64("7"),
		"wrong prefix":         "?paged=1&cursor=" + b64("i:7"),
		"cursor zero":          "?paged=1&cursor=" + b64("b:0"),
		"cursor negative":      "?paged=1&cursor=" + b64("b:-3"),
		"cursor not a number":  "?paged=1&cursor=" + b64("b:x"),
		"cursor not base64url": "?paged=1&cursor=%21%21",
	}
	for name, q := range cases {
		r, err := http.Get(base + "/messages/all" + q)
		require.NoError(t, err)
		r.Body.Close()
		assert.Equal(t, http.StatusBadRequest, r.StatusCode, name)
	}
	r, err := http.Get(base + "/messages/all?paged=1&cursor=" + b64("b:99999"))
	require.NoError(t, err)
	r.Body.Close()
	assert.Equal(t, http.StatusOK, r.StatusCode, "a well-formed cursor past the end is an empty page, not an error")
}
