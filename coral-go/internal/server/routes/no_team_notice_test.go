package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

const noTeamSession = "00000000-0000-4000-8000-00000000a0a0"

func noTeamNoticeRig(t *testing.T) (*BoardHandler, *mockSessionTerminal, string, string, func(sessionLive bool)) {
	t.Helper()
	_, h, coralDir := teamArtifactServer(t)
	h.SetTaskArtifactWriter(coralDir, nil)
	mock := newMockTerminal()
	name := naming.SessionName("claude", noTeamSession)
	mock.addSession(name, "/tmp/solo")
	h.SetTerminal(mock)
	live := true
	h.liveSessionType = func(context.Context, string) (string, bool, error) { return "claude", live, nil }
	id := writeUpload(t, coralDir, noTeamSession, "the report", "report.md", "2026-10-09T10:00:00Z")
	_, err := h.bs.AddArtifactTags(context.Background(), noTeamBoardID, id, []string{"for review"})
	require.NoError(t, err)
	return h, mock, name, id, func(l bool) { live = l }
}

func decideNoTeam(h *BoardHandler, id, body string) (int, map[string]any) {
	req := httptest.NewRequest(http.MethodPost, "/api/board/"+noTeamBoardID+"/artifacts/"+id+"/review", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", noTeamBoardID)
	rctx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.ReviewArtifact(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// The Operator's decision on a file an agent on no team sent for review is typed into the session that uploaded it (#13539): the same words a team agent gets, with the link, the note or the reason, and no mention
// of anyone; an agent that is gone is not told, and the decision stands.
func TestADecisionOnANoTeamFileIsTypedIntoTheSessionThatUploadedIt(t *testing.T) {
	h, mock, name, id, setLive := noTeamNoticeRig(t)
	code, out := decideNoTeam(h, id, `{"decision":"approve","note":"Ship it, tidy the title."}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["delivered"])
	sent := mock.sentTo(name)
	require.Len(t, sent, 1, "one line was typed into the uploader's session")
	assert.Contains(t, sent[0], "coral://artifacts/"+id)
	assert.Contains(t, sent[0], "approved")
	assert.Contains(t, sent[0], "Ship it, tidy the title.")
	assert.NotContains(t, sent[0], "@", "no board, nobody to mention")
	assert.True(t, strings.HasPrefix(sent[0], "[Coral]"), sent[0])

	// a deny carries its reason; the file was approved above, so it is sent for review again
	_, err := h.bs.AddArtifactTags(context.Background(), noTeamBoardID, id, []string{"for review"})
	require.NoError(t, err)
	code, out = decideNoTeam(h, id, `{"decision":"deny","reason":"Wrong template."}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	sent = mock.sentTo(name)
	require.Len(t, sent, 2)
	assert.Contains(t, sent[1], "denied")
	assert.Contains(t, sent[1], "Wrong template.")

	setLive(false) // the agent's session is gone
	_, err = h.bs.AddArtifactTags(context.Background(), noTeamBoardID, id, []string{"for review"})
	require.NoError(t, err)
	code, out = decideNoTeam(h, id, `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, "the decision stands: %v", out)
	assert.Equal(t, false, out["delivered"])
	assert.Equal(t, "asleep_or_gone", out["reason"])
	assert.Len(t, mock.sentTo(name), 2, "nothing more was typed")
	_ = time.Now
	_ = store.SessionTokenHeader
}

// The Operator's comment on a file of the reserved no-team key is typed into the uploader's session with the link and the words, redacted as a sent comment is (#13539); an unknown file or a gone session tells nobody
// and the comment stands.
func TestACommentOnANoTeamFileIsTypedIntoTheSessionThatUploadedIt(t *testing.T) {
	bh, mock, name, id, setLive := noTeamNoticeRig(t)
	_, sh, _, _ := setupSessionsTestServer(t)
	sh.SetBoardHandler(bh)
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+id+"/comments", nil)
	caller := commentCaller{Issuer: "local", Subject: "owner"}
	c := store.ArtifactComment{Body: "Please add the Q4 table. password=hunter2hunter2"}

	d := sh.deliverNoTeamComment(req, caller, c, id)
	require.Equal(t, "the agent that uploaded it", d.To, "reason %q", d.Reason)
	sent := mock.sentTo(name)
	require.Len(t, sent, 1)
	assert.Contains(t, sent[0], "coral://artifacts/"+id)
	assert.Contains(t, sent[0], "Please add the Q4 table.")
	assert.NotContains(t, sent[0], "hunter2hunter2", "the comment is redacted as every sent comment is")
	assert.NotContains(t, sent[0], "@")

	d = sh.deliverNoTeamComment(req, caller, c, strings.Repeat("a", 64))
	assert.Equal(t, autoDelivery{Reason: "no_uploader"}, d, "a file that is not a no-team upload")
	setLive(false)
	d = sh.deliverNoTeamComment(req, caller, c, id)
	assert.Equal(t, autoDelivery{Reason: "asleep_or_gone"}, d)
	assert.Len(t, mock.sentTo(name), 1, "nothing more was typed")
	_ = time.Now

	// the comment route's own delivery reaches it for the reserved key (the wiring, not only the helper)
	setLive(true)
	person := req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	owner := commentCaller{Kind: commentCallerOwner, Issuer: "local", Subject: "owner"}
	d = sh.deliverOperatorComment(person, owner, c, id, noTeamBoardID)
	assert.Equal(t, "the agent that uploaded it", d.To, "reason %q", d.Reason)
	assert.Len(t, mock.sentTo(name), 2)
}
