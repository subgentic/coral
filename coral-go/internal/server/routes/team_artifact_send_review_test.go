package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13217 (the server part of #13152): the Operator sends one of the team's files for review, and takes it out again, from the Artifacts tab, on this computer and through Coral Hub as the owner.
func TestTheOwnerSendsAFileForReviewAndTakesItOutAgain(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	withLabel(t, ownerLabel, nil)
	hub := ownerHeaders(ownerLabel)
	call := func(method, id, body string, header map[string]string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/review", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range header {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode, decodeBody(t, resp)
	}
	tags := func() []string {
		all, err := e.h.bs.ArtifactTags(context.Background(), "tag-team")
		require.NoError(t, err)
		return all[id]
	}
	question := func() string {
		qs, err := e.h.bs.ArtifactQuestions(context.Background(), "tag-team")
		require.NoError(t, err)
		return qs[id].Question
	}

	// an agent's upload asked something of its own; the Operator's question replaces it (the Operator decides what they want decided)
	require.NoError(t, e.h.bs.SetArtifactTags(context.Background(), "tag-team", id, []string{"for review"}))
	_, err := e.h.bs.SetArtifactQuestion(context.Background(), "tag-team", id, "the agent's own question", "claude-agent", time.Now())
	require.NoError(t, err)
	// the owner sends it with a question: tag, question, and the answer says both
	code, out := call(http.MethodPut, id, `{"question":"  Approve the   plan?  "}`, hub)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, id, out["id"])
	assert.Equal(t, []any{"for review"}, out["tags"])
	assert.Equal(t, "Approve the plan?", out["question"], "one cleaned line")
	assert.Equal(t, []string{"for review"}, tags())

	// again with another question: the tag stays once, the question is replaced
	code, out = call(http.MethodPut, id, `{"question":"Ship it?"}`, hub)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []any{"for review"}, out["tags"])
	assert.Equal(t, "Ship it?", question())
	// with none: the file stays for review and the question it has is kept (the Operator's own file needs none)
	code, out = call(http.MethodPut, id, `{}`, hub)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "Ship it?", out["question"])
	assert.Equal(t, []string{"for review"}, tags())
	// a long question is cut at 140
	code, out = call(http.MethodPut, id, `{"question":"`+strings.Repeat("x", 300)+`"}`, hub)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, []rune(out["question"].(string)), 140)

	// the other tags are kept, and taking it out removes the tag and the question and nothing else
	require.NoError(t, e.h.bs.SetArtifactTags(context.Background(), "tag-team", id, []string{"for review", "internal"}))
	code, out = call(http.MethodDelete, id, ``, hub)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []any{"internal"}, out["tags"])
	assert.Equal(t, "", out["question"])
	assert.Equal(t, []string{"internal"}, tags())
	assert.Equal(t, "", question(), "the question goes with the tag")
	code, out = call(http.MethodDelete, id, ``, hub) // not for review: answered as it is
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []any{"internal"}, out["tags"])

	// a file with no tags and no question: the Operator's own file is for review with none
	other := e.ids["final.pdf"]
	code, out = call(http.MethodPut, other, `{}`, hub)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []any{"for review"}, out["tags"])
	assert.Equal(t, "", out["question"])
}

func TestTheReviewRoutesRefuseWhatTheUploadRefusesAndWhatIsNotTheOwners(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	hubCall := func(method, id, body string, header map[string]string) (int, map[string]any) {
		req, err := http.NewRequest(method, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/review", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range header {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode, decodeBody(t, resp)
	}
	tags := func(id string) []string {
		all, err := e.h.bs.ArtifactTags(context.Background(), "tag-team")
		require.NoError(t, err)
		return all[id]
	}

	// through the Hub only the owner: every other caller is a 403 and changes nothing
	for _, c := range hubCallers() {
		withLabel(t, c.label, nil)
		for _, method := range []string{http.MethodPut, http.MethodDelete} {
			code, out := hubCall(method, id, `{"question":"q"}`, c.header)
			if c.allow {
				assert.Equal(t, http.StatusOK, code, "%s %s: %v", c.name, method, out)
			} else {
				assert.Equal(t, http.StatusForbidden, code, "%s %s: %v", c.name, method, out)
			}
		}
	}
	withLabel(t, ownerLabel, nil)
	hub := ownerHeaders(ownerLabel)
	require.NoError(t, e.h.bs.SetArtifactTags(context.Background(), "tag-team", id, nil))

	// a file that is not one of the team's, and a bad id
	code, _ := hubCall(http.MethodPut, strings.Repeat("a", 64), `{}`, hub)
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = hubCall(http.MethodDelete, strings.Repeat("a", 64), ``, hub)
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = hubCall(http.MethodPut, "not-an-id", `{}`, hub)
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = hubCall(http.MethodPut, id, `not json`, hub)
	assert.Equal(t, http.StatusBadRequest, code)
	// a sign-in link as the question is refused, and a file Needs you cannot show is refused as an upload with the tag is
	code, out := hubCall(http.MethodPut, id, `{"question":"open http://localhost:8420/?login_token=0123456789abcdef0123456789abcdef"}`, hub)
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, "sign_in_link", out["code"])
	blob := storeManagedArtifact(t, e.coralDir, "binary bytes", true, false) // stored as octet-stream under a name the viewer does not read
	meta, _ := json.Marshal(agentArtifactMeta{Name: "blob.bin", MediaType: "application/octet-stream", Size: 12, Digest: "sha256:" + blob})
	require.NoError(t, os.WriteFile(filepath.Join(e.coralDir, "artifacts", "objects", blob+".json"), meta, 0o644))
	completeWithArtifacts(t, e.h, "tag-team", "Make blob.bin", []board.TaskArtifact{{Name: "blob.bin", URI: "coral://artifacts/" + blob}})
	code, out = hubCall(http.MethodPut, blob, `{"question":"look"}`, hub)
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, "not_viewable", out["code"])
	assert.Empty(t, tags(blob), "a refused file is not tagged")
	// a file that already has five tags takes no sixth
	require.NoError(t, e.h.bs.SetArtifactTags(context.Background(), "tag-team", id, []string{"a", "b", "c", "d", "e"}))
	code, out = hubCall(http.MethodPut, id, `{"question":"q"}`, hub)
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, "too_many_tags", out["code"])
	assert.Equal(t, []string{"a", "b", "c", "d", "e"}, tags(id))
}

func decodeBody(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out
}

// QA Reviewer 2's SHOULD on #13217: DELETE's write is a compare-and-set. A local tag edit that lands between its read and its write is not lost (the read is taken again), and a list that keeps changing under it is
// a 409 after three more tries, with the file still for review.
func TestTakingAFileOutOfReviewNeverLosesALocalTagEditAndGivesUpWith409(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	ctx := context.Background()
	t.Cleanup(func() { reviewDeleteAfterRead = func() {} })
	del := func() (int, map[string]any) {
		req, err := http.NewRequest(http.MethodDelete, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/review", nil)
		require.NoError(t, err)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode, decodeBody(t, resp)
	}
	tags := func() []string {
		all, err := e.h.bs.ArtifactTags(ctx, "tag-team")
		require.NoError(t, err)
		return all[id]
	}

	// a local edit lands once, right after the read: it is kept, and the file still comes out of review
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"for review", "internal"}))
	fired := 0
	reviewDeleteAfterRead = func() {
		if fired++; fired == 1 {
			require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"for review", "internal", "approved"}))
		}
	}
	code, out := del()
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, 2, fired, "the tags were read again after the change")
	assert.Equal(t, []any{"approved", "internal"}, out["tags"], "the local edit stays, and only the review tag went")
	assert.Equal(t, []string{"approved", "internal"}, tags())

	// a list that changes under every attempt: 409, and nothing was taken out
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"for review", "internal"}))
	n := 0
	reviewDeleteAfterRead = func() {
		n++
		next := []string{"for review", "internal"}
		if n%2 == 1 {
			next = []string{"for review", "internal", "x"}
		}
		require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, next))
	}
	code, out = del()
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, hubTagsRetries+1, n, "one read and three retries")
	assert.Contains(t, tags(), "for review", "the file is still for review")
}
