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
	assert.True(t, strings.HasPrefix(sent[1], "[Coral]"), sent[1])
	assert.NotContains(t, sent[1], "@", "a deny names no one either")

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
	assert.True(t, strings.HasPrefix(sent[0], "[Coral]"), sent[0])

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

// The same bytes uploaded by two agents on no team name no one of them (#13539, Security's SHOULD): neither is told, the answer says ambiguous_uploader, and the decision or comment stands. Typing it into the wrong
// agent is the risk; the one-uploader case above is unchanged.
func TestADecisionOrCommentOnBytesTwoNoTeamAgentsUploadedTellsNoneOfThem(t *testing.T) {
	h, mock, name, id, _ := noTeamNoticeRig(t)
	const other = "00000000-0000-4000-8000-00000000b0b0"
	otherName := naming.SessionName("claude", other)
	mock.addSession(otherName, "/tmp/solo2")
	writeUpload(t, h.coralDir, other, "the report", "report.md", "2026-10-09T10:05:00Z") // the same bytes: the same object, held by two sessions

	code, out := decideNoTeam(h, id, `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, "the decision stands: %v", out)
	assert.Equal(t, false, out["delivered"])
	assert.Equal(t, "ambiguous_uploader", out["reason"])
	assert.Empty(t, mock.sentTo(name), "neither agent was told")
	assert.Empty(t, mock.sentTo(otherName))

	_, sh, _, _ := setupSessionsTestServer(t)
	sh.SetBoardHandler(h)
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+id+"/comments", nil)
	d := sh.deliverNoTeamComment(req, commentCaller{Issuer: "local", Subject: "owner"}, store.ArtifactComment{Body: "A comment."}, id)
	assert.Equal(t, autoDelivery{Reason: "ambiguous_uploader"}, d)
	assert.Empty(t, mock.sentTo(name))
	assert.Empty(t, mock.sentTo(otherName))
}

// The guards that stand between a no-team notice and the terminal (QA Reviewer 2's SHOULDs on #13539): an asleep uploader is not typed into, the owner's comments are rate limited as every sent comment is, and a
// comment the redactor cannot make safe is not typed. Each tells nobody and the decision or comment stands.
func TestTheGuardsBeforeANoTeamNoticeIsTyped(t *testing.T) {
	h, mock, name, id, _ := noTeamNoticeRig(t)
	_, sh, _, _ := setupSessionsTestServer(t)
	sh.SetBoardHandler(h)
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+id+"/comments", nil)
	caller := commentCaller{Issuer: "local", Subject: "owner"}

	// a sleeping uploader
	h.sessionAsleep = func(context.Context, string) bool { return true }
	code, out := decideNoTeam(h, id, `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, false, out["delivered"])
	assert.Equal(t, "asleep_or_gone", out["reason"], "an asleep agent is not typed into")
	assert.Equal(t, autoDelivery{Reason: "asleep_or_gone"}, sh.deliverNoTeamComment(req, caller, store.ArtifactComment{Body: "A comment."}, id))
	assert.Empty(t, mock.sentTo(name))
	h.sessionAsleep = nil

	// a comment the redactor cannot make safe: nothing is typed
	redactCommentFailsFor = func(text string) bool { return strings.Contains(text, "unredactable") }
	t.Cleanup(func() { redactCommentFailsFor = nil })
	assert.Equal(t, autoDelivery{Reason: "redaction_unavailable"}, sh.deliverNoTeamComment(req, caller, store.ArtifactComment{Body: "An unredactable comment."}, id))
	assert.Empty(t, mock.sentTo(name), "a comment the redactor cannot make safe is not typed")
	redactCommentFailsFor = nil

	// the hourly limit of sent comments
	var last autoDelivery
	limited := commentCaller{Issuer: "local", Subject: "owner-for-the-limit"} // its own count: the cases above spent none of it
	for i := 0; i <= sendLimitPerHour; i++ {
		last = sh.deliverNoTeamComment(req, limited, store.ArtifactComment{Body: "Another comment."}, id)
	}
	assert.Equal(t, autoDelivery{Reason: "rate_limited"}, last, "past sendLimitPerHour comments an hour the next is not typed")
	assert.Len(t, mock.sentTo(name), sendLimitPerHour, "exactly the allowed ones were typed")
}

// QA Reviewer 2's two remaining pins (#13539): an idle waker that refuses to wake the uploader gives asleep_or_gone and types nothing, and a session that is not named or a file nobody holds gives no_uploader.
func TestTheIdleWakerAndTheMissingUploaderBeforeANoTeamNoticeIsTyped(t *testing.T) {
	h, mock, name, id, _ := noTeamNoticeRig(t)
	ctx := context.Background()

	woken := 0
	h.idleWaker = func(context.Context, string) bool { woken++; return false } // an auto-asleep agent that cannot be woken
	delivered, why := h.tellNoTeamUploaderOf(ctx, id, "[Coral] a line")
	assert.False(t, delivered)
	assert.Equal(t, "asleep_or_gone", why, "an agent the idle waker cannot wake is not typed into")
	assert.Equal(t, 1, woken, "the waker was asked")
	assert.Empty(t, mock.sentTo(name))
	h.idleWaker = func(context.Context, string) bool { return true }
	delivered, why = h.tellNoTeamUploaderOf(ctx, id, "[Coral] a line")
	assert.True(t, delivered, "woken: it is typed (%q)", why)
	h.idleWaker = nil

	delivered, why = h.tellNoTeamUploader(ctx, "", "[Coral] a line")
	assert.False(t, delivered)
	assert.Equal(t, "no_uploader", why, "a record with no session names no one")
	delivered, why = h.tellNoTeamUploaderOf(ctx, strings.Repeat("c", 64), "[Coral] a line")
	assert.False(t, delivered)
	assert.Equal(t, "no_uploader", why, "a file no session of an agent on no team holds")
	assert.Len(t, mock.sentTo(name), 1, "only the woken one was typed")
}
