package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #13976: Request changes in one call. The decision carries the Operator's words (text): this computer records the decision, makes the thread comment and tells the uploader, in one step or not at all.

type changesEnv struct {
	*reviewEnv
	sh   *SessionsHandler
	ss   *store.SessionStore
	srv2 *httptest.Server
}

func newChangesEnv(t *testing.T) *changesEnv {
	t.Helper()
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`) // on the env's own router, before this one replaces it
	cfg := config.Load(e.h.coralDir)
	_, sh, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	sh.bs = e.h.bs
	sh.commentOwner = func(*http.Request) (string, string, string) { return "local", "install-owner-id", "" }
	e.h.SetChangeWords(sh.ChangeRequestWords)
	// the uploader: a live session on the board, with the upload record that says it put the file there
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sessAlice, AgentType: "claude", AgentName: "Alice", WorkingDir: t.TempDir()}))
	dir := uploadsDir(sh.cfg.CoralDir(), sessAlice)
	require.NotEmpty(t, dir)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Size: 4, Digest: "sha256:" + e.id}, CreatedAt: "2026-10-31T00:00:00Z", Board: "alpha"})
	require.NoError(t, os.WriteFile(filepath.Join(dir, e.id+".json"), rec, 0o644))
	// the review route again, on a router of its own that is the person at the dashboard
	r := chi.NewRouter()
	r.Post("/api/board/{project}/artifacts/{id}/review", func(w http.ResponseWriter, req *http.Request) {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		e.h.ReviewArtifact(w, req)
	})
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	e.srv = s
	return &changesEnv{reviewEnv: e, sh: sh, ss: ss, srv2: s}
}

func (c *changesEnv) changes(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	return c.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+c.id+"/review", body)
}

func (c *changesEnv) comments(t *testing.T) []store.ArtifactComment {
	t.Helper()
	out, err := c.ss.ListArtifactComments(context.Background(), c.id, "", []string{"alpha"})
	require.NoError(t, err)
	var live []store.ArtifactComment
	for _, x := range out {
		if x.DeletedAt == nil {
			live = append(live, x)
		}
	}
	return live
}

func (c *changesEnv) state(t *testing.T) []string { return c.h.bsTags(t)[c.id] }

func TestRequestChangesWithTextIsOneCallThatDecidesCommentsAndTellsTheAgent(t *testing.T) {
	c := newChangesEnv(t)
	code, out := c.changes(t, `{"decision":"changes","text":"Use 5,000 rows per batch."}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "changes requested", out["state"])
	assert.Equal(t, true, out["text_kept"])
	assert.Equal(t, true, out["delivered"])
	assert.Equal(t, "Alice", out["to"])
	cs := c.comments(t)
	require.Len(t, cs, 1)
	assert.Equal(t, "Changes requested: Use 5,000 rows per batch.", cs[0].Body)
	assert.Equal(t, "owner", cs[0].AuthorKind)
	assert.Equal(t, float64(cs[0].ID), out["comment_id"])
	assert.Contains(t, cs[0].AnchorJSON, `"whole":true`)
	msgs := c.messages(t)
	require.Len(t, msgs, 1, "one notice, to the uploader")
	assert.Contains(t, msgs[0], "@Alice ")
	assert.Contains(t, msgs[0], "Use 5,000 rows per batch.")
	assert.Contains(t, msgs[0], "untrusted")
	// the decision's own Activity row carries the words
	rows, err := c.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 20})
	require.NoError(t, err)
	var noted bool
	for _, r := range rows {
		if r.Action == board.ActChanges && strings.Contains(r.Note, "Use 5,000 rows per batch.") {
			noted = true
		}
	}
	assert.True(t, noted, "the Activity record has the words")
}

func TestRequestChangesWithNoTextIsTodaysDecisionAndNothingElse(t *testing.T) {
	c := newChangesEnv(t)
	for _, body := range []string{`{"decision":"changes"}`, `{"decision":"changes","text":"   "}`} {
		code, out := c.changes(t, body)
		require.Equal(t, http.StatusOK, code, out)
		assert.NotContains(t, out, "text_kept", "an answer with no words says nothing of them")
		assert.Empty(t, c.comments(t))
		assert.Empty(t, c.messages(t))
	}
}

// SHOULD A (Security): the same words again, on a file already at changes requested by this request, make no second comment and no second notice.
func TestTheSameWordsAgainMakeNoSecondCommentOrNotice(t *testing.T) {
	c := newChangesEnv(t)
	body := `{"decision":"changes","text":"Use 5,000 rows per batch."}`
	code, first := c.changes(t, body)
	require.Equal(t, http.StatusOK, code, first)
	code, again := c.changes(t, body)
	require.Equal(t, http.StatusOK, code, again)
	assert.Equal(t, false, again["changed"])
	assert.Equal(t, true, again["text_kept"])
	assert.Equal(t, first["comment_id"], again["comment_id"], "the comment of the first request")
	assert.Len(t, c.comments(t), 1)
	assert.Len(t, c.messages(t), 1)
	// other words are a new request: one more comment and notice
	code, out := c.changes(t, `{"decision":"changes","text":"And add a retry."}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Len(t, c.comments(t), 2)
	assert.Len(t, c.messages(t), 2)
}

// SHOULD A: a half failure left the words and no decision; the retry reuses the comment and finishes the rest.
func TestARetryAfterAHalfFailureReusesTheCommentAndFinishes(t *testing.T) {
	c := newChangesEnv(t)
	_, err := c.ss.CreateArtifactComment(context.Background(), store.ArtifactComment{ArtifactID: c.id, Board: "alpha", AnchorJSON: `{"quote":"","whole":true}`, Body: "Changes requested: Use 5,000 rows.",
		AuthorIssuer: "local", AuthorSubject: "install-owner-id", AuthorName: "You", AuthorKind: "owner"})
	require.NoError(t, err)
	code, out := c.changes(t, `{"decision":"changes","text":"Use 5,000 rows."}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["changed"])
	assert.Len(t, c.comments(t), 1, "no second comment")
	assert.Len(t, c.messages(t), 1, "the notice the half failure never sent")
	assert.Equal(t, []string{"changes requested", "for review"}, c.state(t))
}

// The decision and the words are one step: a comment that cannot be kept leaves no decision, a notice that cannot be posted leaves neither.
func TestWhenTheWordsCannotBeKeptTheDecisionIsNotRecorded(t *testing.T) {
	c := newChangesEnv(t)
	before := c.state(t)
	// the comment cannot be made: the artifact holds the most comments it can
	for i := 0; i < store.MaxArtifactComments; i++ {
		_, err := c.ss.CreateArtifactComment(context.Background(), store.ArtifactComment{ArtifactID: c.id, Board: "alpha", AnchorJSON: `{"quote":"","whole":true}`, Body: "x", AuthorIssuer: "local", AuthorSubject: "someone", AuthorName: "x", AuthorKind: "owner"})
		require.NoError(t, err)
	}
	code, out := c.changes(t, `{"decision":"changes","text":"Use 5,000 rows."}`)
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "too_many_comments", out["code"])
	assert.Equal(t, before, c.state(t), "still waiting: the button can be pressed again")
	assert.Empty(t, c.messages(t))
}

func TestWhenTheAgentCannotBeToldTheCommentAndTheDecisionAreBothUndone(t *testing.T) {
	c := newChangesEnv(t)
	before := c.state(t)
	_, err := c.sh.db.ExecContext(context.Background(), `DROP TABLE artifact_comment_asks`) // the ask that lets the agent answer cannot be made: the notice fails
	require.NoError(t, err)
	code, out := c.changes(t, `{"decision":"changes","text":"Use 5,000 rows."}`)
	assert.GreaterOrEqual(t, code, 500, out)
	assert.Equal(t, before, c.state(t), "the decision is undone")
	assert.Empty(t, c.comments(t), "and so is the comment")
	assert.Empty(t, c.messages(t))
}

func TestAnAgentThatIsGoneIsNotAFailure(t *testing.T) {
	c := newChangesEnv(t)
	require.NoError(t, c.ss.SetSessionArchived(context.Background(), sessAlice, true))
	code, out := c.changes(t, `{"decision":"changes","text":"Use 5,000 rows."}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["text_kept"])
	assert.Equal(t, false, out["delivered"])
	assert.NotEmpty(t, out["reason"])
	assert.Len(t, c.comments(t), 1, "decided, and the words are in the thread")
}

// The limits are the comment's, checked before anything is written, and the refusals never carry the words.
func TestTheWordsAreHeldToACommentsLimitsAndNeverEchoed(t *testing.T) {
	c := newChangesEnv(t)
	before := c.state(t)
	secret := "do-not-echo-this-text"
	refuse := func(text string, wantCode int, wantWhy string) {
		code, out := c.changes(t, chgJSON(map[string]any{"decision": "changes", "text": text}))
		assert.Equal(t, wantCode, code, wantWhy)
		raw, _ := json.Marshal(out)
		assert.NotContains(t, string(raw), secret, wantWhy)
		assert.Equal(t, before, c.state(t), wantWhy+": nothing recorded")
		assert.Empty(t, c.comments(t), wantWhy)
		assert.Empty(t, c.messages(t), wantWhy)
	}
	refuse(secret+strings.Repeat("a", store.MaxArtifactCommentBody), http.StatusRequestEntityTooLarge, "too long")
	refuse(secret+" open https://example.com/x?login_token="+secretToken, http.StatusBadRequest, "a sign-in link")
	redactCommentFailsFor = func(text string) bool { return strings.Contains(text, secret) }
	t.Cleanup(func() { redactCommentFailsFor = nil })
	refuse(secret+" is the plan", http.StatusServiceUnavailable, "the redactor is down: fail closed")
	redactCommentFailsFor = nil
	code, out := c.changes(t, chgJSON(map[string]any{"decision": "changes", "text": "a plain one"}))
	require.Equal(t, http.StatusOK, code, out)
}

// The words reach the notice and the thread redacted: a secret in them is not kept anywhere, and the Activity row is cut.
func TestTheWordsAreRedactedAndTheActivityRowIsCut(t *testing.T) {
	c := newChangesEnv(t)
	long := strings.Repeat("word ", 300) // 1,500 characters
	code, out := c.changes(t, chgJSON(map[string]any{"decision": "changes", "text": long + " " + changesSecret}))
	require.Equal(t, http.StatusOK, code, out)
	rows, err := c.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 20})
	require.NoError(t, err)
	var note string
	for _, r := range rows {
		if r.Action == board.ActChanges {
			note = r.Note
		}
	}
	require.NotEmpty(t, note)
	assert.LessOrEqual(t, len([]rune(note)), board.ActivityNoteCap+1, "the Activity row is cut by the record itself")
	for _, cm := range c.comments(t) {
		assert.NotContains(t, cm.Body, changesSecret)
	}
}

func TestPicturesAreNotInThisSlice(t *testing.T) {
	c := newChangesEnv(t)
	for _, body := range []string{`{"decision":"changes","text":"x","images":["` + strings.Repeat("a", 64) + `"]}`, `{"decision":"changes","text":"x","images":[]}`, `{"decision":"changes","text":"x","images":null}`} {
		code, out := c.changes(t, body)
		assert.Equal(t, http.StatusBadRequest, code, body)
		assert.Equal(t, "images_not_in_this_slice", out["code"], body)
	}
	assert.Empty(t, c.comments(t))
	assert.Empty(t, c.messages(t))
}

func TestTextGoesWithRequestChangesOnly(t *testing.T) {
	c := newChangesEnv(t)
	for _, d := range []string{"approve", "deny", "ignore", "save"} {
		code, out := c.changes(t, chgJSON(map[string]any{"decision": d, "text": "words"}))
		assert.Equal(t, http.StatusBadRequest, code, d)
		assert.Equal(t, "text_only_for_changes", out["code"], d)
	}
}

// SHOULD C (Security): the signed body is part of the stamp and the Hub's own limit applies. The most text the route takes, in the worst spelling JSON has (every character escaped), is under that limit.
func TestTheLongestWordsFitTheHubsSignedBody(t *testing.T) {
	worst := strings.Repeat("\u0001", store.MaxArtifactCommentBody) // one byte of text is six in the JSON
	body := `{"decision":"changes","text":"` + worst + `"}`
	assert.Less(t, len(body), hubowner.MaxBody, "a decision with the most text still fits the signed body")
	assert.Less(t, store.MaxArtifactCommentBody*6+200, hubowner.MaxBody)
}

const changesSecret = "ghp_a1B2c3D4a1B2c3D4a1B2c3D4a1B2c3D4a1B2c3D4"

func chgJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

// Orchestrator's point 1: a file already at changes requested, a new request whose comment then fails, keeps the earlier decision (undoing an unchanged decision is a no-op) and what it had made.
func TestAFailedRetryOnAFileAlreadyAtChangesKeepsTheEarlierDecision(t *testing.T) {
	c := newChangesEnv(t)
	code, first := c.changes(t, `{"decision":"changes","text":"First words."}`)
	require.Equal(t, http.StatusOK, code, first)
	afterFirst := c.state(t)
	require.Contains(t, afterFirst, "changes requested")
	for i := 0; i < store.MaxArtifactComments; i++ { // the artifact cannot take another comment
		if len(c.comments(t)) >= store.MaxArtifactComments {
			break
		}
		_, err := c.ss.CreateArtifactComment(context.Background(), store.ArtifactComment{ArtifactID: c.id, Board: "alpha", AnchorJSON: `{"quote":"","whole":true}`, Body: "x", AuthorIssuer: "local", AuthorSubject: "someone", AuthorName: "x", AuthorKind: "owner"})
		require.NoError(t, err)
	}
	code, out := c.changes(t, `{"decision":"changes","text":"Second words."}`)
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "too_many_comments", out["code"])
	assert.Equal(t, afterFirst, c.state(t), "the earlier decision is still there")
	var first1 bool
	for _, cm := range c.comments(t) {
		first1 = first1 || cm.Body == "Changes requested: First words."
		assert.NotEqual(t, "Changes requested: Second words.", cm.Body)
	}
	assert.True(t, first1, "and the earlier comment")
	assert.Len(t, c.messages(t), 1, "no second notice")
}

// Orchestrator's point 2: the lookup of an earlier comment and the making of a new one are one step per artifact: requests at once make one comment and one notice.
func TestRequestsAtOnceMakeOneCommentAndOneNotice(t *testing.T) {
	c := newChangesEnv(t)
	const n = 12
	codes := make(chan int, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		go func() {
			<-start
			code, _ := c.changesNoT(`{"decision":"changes","text":"Use 5,000 rows per batch."}`)
			codes <- code
		}()
	}
	close(start)
	for i := 0; i < n; i++ {
		assert.Equal(t, http.StatusOK, <-codes)
	}
	assert.Len(t, c.comments(t), 1, "one comment")
	assert.Len(t, c.messages(t), 1, "one notice")
}

func (c *changesEnv) changesNoT(body string) (int, map[string]any) {
	req, err := http.NewRequest(http.MethodPost, c.srv.URL+"/api/board/alpha/artifacts/"+c.id+"/review", strings.NewReader(body))
	if err != nil {
		return 0, nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// QA's pin: the words' half is the owner's alone, whoever reaches it. A caller that is no owner (an agent's session, a Hub viewer, nobody) gets owner_only and nothing is written: no comment, no notice, no ask.
func TestAnyoneButTheOwnerGetsOwnerOnlyAndNothingIsWritten(t *testing.T) {
	c := newChangesEnv(t)
	agent := httptest.NewRequest(http.MethodPost, "/x", nil)
	agent = agent.WithContext(context.WithValue(agent.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sessAlice, SessionName: "claude-" + sessAlice})) // status 0, kind agent
	nobody := httptest.NewRequest(http.MethodPost, "/x", nil)                                                                                                               // no caller at all
	hub := httptest.NewRequest(http.MethodPost, "/x", nil)
	hub.Header.Set("X-Coral-Via", "x") // a hub viewer's request, never the owner's
	for name, req := range map[string]*http.Request{"an agent's session": agent, "nobody": nobody, "a hub viewer": hub} {
		_, err := c.sh.ChangeRequestWords(req, "alpha", c.id, "Use 5,000 rows.")
		var ce *changeWordsError
		require.ErrorAs(t, err, &ce, name)
		assert.Equal(t, "owner_only", ce.Code, name)
		assert.Equal(t, http.StatusForbidden, ce.Status, name)
	}
	assert.Empty(t, c.comments(t), "no comment")
	assert.Empty(t, c.messages(t), "no notice")
	asks, err := c.ss.ListArtifactAsks(context.Background(), c.id)
	require.NoError(t, err)
	assert.Empty(t, asks, "no ask")
}
