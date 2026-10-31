package opencode

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What a 1.19.5 server really sends (captured; trimmed): /session/<id>/message gives the newest N messages oldest first, as {info, parts}, with the older page's cursor in X-Next-Cursor; the v2 route
// /api/session/<id>/message answers an empty list on that build.
func TestMessagesOfAOneDotXServerAreReadFromItsLegacyRouteAndPaged(t *testing.T) {
	const user = `{"info":{"id":"msg_user","sessionID":"ses_abc123","role":"user","time":{"created":1793405453108},"agent":"build"},"parts":[{"id":"prt_1","type":"text","text":"Write a haiku about coral reefs, three lines only."}]}`
	const assistant = `{"info":{"id":"msg_asst","sessionID":"ses_abc123","role":"assistant","time":{"created":1793405453115,"completed":1793405455382}},"parts":[{"type":"step-start"},{"type":"text","text":"Coral cities bloom\nbeneath the warm turquoise"},{"type":"step-finish"}]}`
	const tools = `{"info":{"id":"msg_tools","sessionID":"ses_abc123","role":"assistant","time":{"created":1793405460000}},"parts":[{"type":"tool","state":{}}]}`
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path+"?"+r.URL.RawQuery)
		switch {
		case r.URL.Path == "/api/session/ses_abc123/message":
			fmt.Fprint(w, `{"data":[],"cursor":{"previous":null,"next":null}}`)
		case r.URL.Path == "/session/ses_abc123/message" && r.URL.Query().Get("before") == "":
			w.Header().Set("X-Next-Cursor", "eyJpZCI6Im1zZ19hc3N0In0")
			fmt.Fprintf(w, "[%s,%s]", assistant, tools)
		case r.URL.Path == "/session/ses_abc123/message" && r.URL.Query().Get("before") == "eyJpZCI6Im1zZ19hc3N0In0":
			fmt.Fprintf(w, "[%s]", user)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c, err := New(srv.URL, "pw")
	require.NoError(t, err)
	c = c.ForVersion(1)

	all, err := c.AllMessages(context.Background(), "ses_abc123")
	require.NoError(t, err)
	require.Len(t, all, 2, "the turn of tool calls alone says nothing")
	assert.Equal(t, "user", all[0].Role, "oldest first")
	assert.Equal(t, "Write a haiku about coral reefs, three lines only.", all[0].Text)
	assert.Equal(t, "Coral cities bloom\nbeneath the warm turquoise", all[1].Text, "the text parts only: no step markers")
	assert.Equal(t, "1793405453115", all[1].At)
	for _, a := range asked {
		assert.NotContains(t, a, "/api/session/", "1.x is never asked on the route that answers empty")
	}

	last, ok, err := c.LastMessage(context.Background(), "ses_abc123")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "msg_asst", last.ID, "the newest message with text")

	for _, bad := range []string{"a b", "<x>", "../x"} {
		w := httptest.NewRecorder()
		w.Header().Set("X-Next-Cursor", bad)
		assert.False(t, cursorRe.MatchString(w.Header().Get("X-Next-Cursor")), "%q", bad)
	}
}
