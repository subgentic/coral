package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7794: post --ask marks the post as a question and --reply-to links an answer; read says which messages are questions (with the id that answers one) and which are answers.
func TestPostAskAndReplyToSendTheirFields(t *testing.T) {
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--ask", "@Dev A which parser do we keep?")
	require.Equal(t, 0, res.code, res.stderr)
	res = runBoard(t, srv.URL, dir, "post", "--reply-to", "42", "@Lead the old one")
	require.Equal(t, 0, res.code, res.stderr)
	reqs := srv.requests()
	require.Len(t, reqs, 2)
	assert.Contains(t, reqs[0], `"ask":true`)
	assert.Contains(t, reqs[0], `"content":"@Dev A which parser do we keep?"`)
	assert.NotContains(t, reqs[0], "reply_to")
	assert.Contains(t, reqs[1], `"reply_to":42`)
	assert.NotContains(t, reqs[1], `"ask"`)

	srv2 := newRecordingServer(t)
	dir2 := subscribedDataDir(t, srv2.URL)
	for name, args := range map[string][]string{
		"a reply_to that is no number": {"post", "--reply-to", "x", "hi"},
		"reply_to 0":                   {"post", "--reply-to", "0", "hi"},
		"reply_to with no value":       {"post", "--reply-to"},
		"ask and assign":               {"post", "--ask", "--assign", "Dev A", "--goal", "1", "@Dev A hi"},
	} {
		res := runBoard(t, srv2.URL, dir2, args...)
		assert.Equal(t, 2, res.code, "%s: %q", name, res.stderr)
	}
	assert.Empty(t, srv2.requests(), "a bad option sends nothing")
}

func TestReadSaysWhichMessagesAreQuestionsAndAnswers(t *testing.T) {
	t.Setenv("CORAL_SUBSCRIBER_ID", "Dev B")
	out := captureStdout(t, func() {
		printMessages([]map[string]any{
			{"id": 10.0, "created_at": "2026-10-26T04:00:00Z", "subscriber_id": "Lead", "content": "@Dev A @Dev B parser?", "ask": map[string]any{"to": []any{"Dev A", "Dev B"}, "open": []any{"Dev B"}, "answered": false}},
			{"id": 11.0, "created_at": "2026-10-26T04:01:00Z", "subscriber_id": "Lead", "content": "@Dev A tests?", "ask": map[string]any{"to": []any{"Dev A"}, "open": []any{"Dev A"}, "answered": false}},
			{"id": 12.0, "created_at": "2026-10-26T04:02:00Z", "subscriber_id": "Lead", "content": "@Dev A done?", "ask": map[string]any{"to": []any{"Dev A"}, "open": []any{}, "answered": true}},
			{"id": 13.0, "created_at": "2026-10-26T04:03:00Z", "subscriber_id": "Dev A", "content": "the old one", "reply_to": 10.0},
			{"id": 14.0, "created_at": "2026-10-26T04:04:00Z", "subscriber_id": "Lead", "content": "a plain post"},
		})
	})
	assert.Contains(t, out, `(a question for you, message #10, with no answer from you yet: answer it with  coral-board post --reply-to 10 "...")`, "a question you owe says how to answer it")
	assert.Contains(t, out, "(a question, message #11: waiting on Dev A)", "a question to someone else says who it waits on")
	assert.Contains(t, out, "(a question, message #12: answered)")
	assert.Contains(t, out, "(a reply to message #10)")
	assert.Equal(t, 3, countOf(out, "(a question"), "only the questions say so")
}

func countOf(s, sub string) int {
	n := 0
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			n++
		}
	}
	return n
}

// #9054: read says, under a message from another board, how to answer it: the server's own line, printed as it is.
func TestReadPrintsTheReplyLineOfAMessageFromAnotherBoard(t *testing.T) {
	out := captureStdout(t, func() {
		printMessages([]map[string]any{
			{"id": float64(812), "created_at": "2026-10-27T10:00:00Z", "job_title": "Orchestrator (design-team)", "content": "can you expose the tokens API?",
				"reply_with": `Reply with: coral-board send --board design-team --reply-to 812 "..."`},
			{"id": float64(813), "created_at": "2026-10-27T10:01:00Z", "job_title": "Dev", "content": "an ordinary message"},
		})
	})
	if !strings.Contains(out, `  (Reply with: coral-board send --board design-team --reply-to 812 "...")`) {
		t.Errorf("the line is missing:\n%s", out)
	}
	if strings.Count(out, "Reply with:") != 1 {
		t.Errorf("only the message from another board has one:\n%s", out)
	}
}
