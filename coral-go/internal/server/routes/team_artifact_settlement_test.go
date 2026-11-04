package routes

import (
	"context"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/tracking"
	"net/http"
	"testing"
)

func TestQuietOlderVersionSettlementIsSupersededAndNotAnInboxIgnore(t *testing.T) {
	sink := captureAnalytics(t)
	e := newReviewEnv(t, true)
	e.tag(t, `["for review","read","changes requested","saved","custom"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 200, code, out)
	tags, err := e.h.bs.ArtifactTags(context.Background(), "alpha")
	require.NoError(t, err)
	require.Contains(t, tags[e.id], "superseded")
	for _, tag := range []string{"ignored", "for review", "changes requested", "saved", "read"} {
		require.NotContains(t, tags[e.id], tag)
	}
	require.Contains(t, tags[e.id], "custom")
	reviews, err := e.h.bs.ArtifactReviews(context.Background(), "alpha")
	require.NoError(t, err)
	require.Equal(t, "superseded", reviews[e.id].State)
	require.Empty(t, e.messages(t))
	sink.none(t, tracking.EventInboxItemActioned)
	code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 409, code, out)
	require.Equal(t, "not_for_review", out["code"])
	e.tag(t, `["for review"]`)
	code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore"}`)
	require.Equal(t, 200, code, out)
	events := sink.wait(t, tracking.EventInboxItemActioned, 1)
	require.Len(t, events, 1)
	require.Equal(t, "ignore", events[0]["action"])
}

func TestQuietSettlementStillRequiresPersonAndOnlyAppliesToIgnore(t *testing.T) {
	e := newReviewEnv(t, false)
	e.tag(t, `["for review"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 403, code, out)
	e = newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	for _, decision := range []string{"approve", "deny", "changes", "save", "unignore"} {
		code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"`+decision+`","quiet":true}`)
		require.Equal(t, 400, code, out)
	}
}
