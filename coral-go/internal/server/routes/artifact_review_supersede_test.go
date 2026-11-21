package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #136588 (Mobile Beta Tester, live): after Request changes on v1, an upload of v2 in the same series with --tag "for review" closes v1's review: v1 leaves Needs you as superseded and keeps no
// "changes requested" tag; v2 is the one pending.
func TestANewVersionForReviewSupersedesTheOlderOne(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	ctx := context.Background()
	up := func(session, text, ref string) string {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id="+session+"&tag=for+review&question=Approve+the+spec%3F", strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "spec.md")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	v1 := up("a1", "spec v1", "")
	_, _, err := rig.h.bs.DecideArtifactReview(ctx, "team-a", v1, board.ReviewChangesRequested, time.Now())
	require.NoError(t, err)
	v2 := up("a1", "spec v2", "coral://artifacts/"+v1)

	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Equal(t, []string{"superseded"}, tags[v1], "v1 is no longer something to review, and keeps no changes requested tag")
	assert.Contains(t, tags[v2], "for review", "v2 is the pending one")
}

// #11985 (the operator): after Request changes the file leaves Needs you, so the agent's next version must come back: an upload of version 2 of a file whose changes were requested is tagged for review even
// when the agent forgot --tag, closes version 1's review, and is the one thing /api/needs-you lists; without it the file would vanish from Needs you without a trace.
func TestTheNextVersionOfAFileWithChangesRequestedComesBackForReview(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	up := func(session, text, ref string, tagged bool) string {
		url := rig.srv.URL + "/api/agent/artifacts?session_id=" + session
		if tagged {
			url += "&tag=for+review&question=Approve+the+spec%3F"
		}
		req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "spec.md")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	v1 := up("a1", "spec v1", "", true)
	_, _, err := rig.h.bs.DecideArtifactReview(ctx, "team-a", v1, board.ReviewChangesRequested, time.Now())
	require.NoError(t, err)
	// the agent forgets --tag
	v2 := up("a1", "spec v2", "coral://artifacts/"+v1, false)
	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Contains(t, tags[v2], "for review", "the next version of a file with changes requested is for review even without --tag")
	assert.Equal(t, []string{"superseded"}, tags[v1], "and version 1's review is closed")
	// a first upload with no tag stays untagged: only a file whose changes were requested is brought back
	plain := up("a1", "something else", "", false)
	tags, err = rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.NotContains(t, tags[plain], "for review", "an ordinary upload is not tagged for review")
}

// #14964 (the Operator): a file sent for review as version 1 and then uploaded as versions 2 to 4 with --new-version-of and no --tag showed in Needs you as "version 1" with Approve, and versions 2 to 4 were not
// there at all: an approval of version 1 would stand for none of them. A new version of a file still waiting for review is the one for review (the newest), and the older versions' reviews are closed.
func TestANewVersionOfAFileStillWaitingForReviewIsTheOneForReview(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	up := func(text, ref string, tagged bool) string {
		url := rig.srv.URL + "/api/agent/artifacts?session_id=a1"
		if tagged {
			url += "&tag=for+review&question=Approve+the+mock%3F"
		}
		req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "mock.html")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	v1 := up("mock v1", "", true)
	v2 := up("mock v2", "coral://artifacts/"+v1, false)
	qs, qerr := rig.h.bs.ArtifactQuestions(ctx, "team-a")
	require.NoError(t, qerr)
	assert.Equal(t, "Approve the mock?", qs[v2].Question, "the question asked of version 1 is carried to the auto-tagged version (#14969)")
	v3 := up("mock v3", "coral://artifacts/"+v2, false)
	v4 := up("mock v4", "coral://artifacts/"+v3, false)
	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Equal(t, []string{"for review"}, tags[v4], "the newest version is the one for review")
	for _, old := range []string{v1, v2, v3} {
		assert.NotContains(t, tags[old], "for review", "an older version is superseded, not a decision of its own")
	}
	assert.Equal(t, []string{"superseded"}, tags[v1])

	// a file that was never for review does not become so by a new version
	p1 := up("plain v1", "", false)
	p2 := up("plain v2", "coral://artifacts/"+p1, false)
	tags, err = rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.NotContains(t, tags[p2], "for review", "a file that was not for review does not become so by a new version")
}

// #20401 (the Operator): promo-cut-1.mp4 v17 was approved, v18 was uploaded with --new-version-of and no --tag, and it never came back to Needs you. A new version of a file the Operator reviewed (approved or
// sent back) is for review again, as a new version of the same row, with a question; the older version keeps its decision; --no-review opts out; and the upload's answer says whether it reached the Inbox.
func TestANewVersionOfAnApprovedFileComesBackToTheInbox(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	up := func(text, ref, extra string) (string, map[string]any) {
		url := rig.srv.URL + "/api/agent/artifacts?session_id=a1" + extra
		req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "mock.html")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/"), out
	}
	v1, first := up("cut v1", "", "&tag=for+review&question=Approve+the+cut%3F")
	assert.Equal(t, true, first["for_review"], "the answer says it is in the Inbox")
	_, _, err := rig.h.bs.DecideArtifactReview(ctx, "team-a", v1, board.ReviewApproved, time.Now())
	require.NoError(t, err)

	v2, second := up("cut v2", "coral://artifacts/"+v1, "")
	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Contains(t, tags[v2], "for review", "a new version of an approved file is for review again")
	assert.Contains(t, tags[v1], "approved", "the approved version keeps its decision")
	assert.NotContains(t, tags[v1], "for review")
	qs, err := rig.h.bs.ArtifactQuestions(ctx, "team-a")
	require.NoError(t, err)
	assert.Equal(t, "Look at the new version of mock.html?", qs[v2].Question, "a decision clears the question: the returning version asks the plain ask (its note, when it has one)")
	assert.Equal(t, true, second["for_review"])
	assert.Contains(t, second["inbox"], "Inbox", "the answer says where it went")

	// the opt-out: a version that is not for the Operator's eyes says so, and the answer says it did not reach them
	_, _, err = rig.h.bs.DecideArtifactReview(ctx, "team-a", v2, board.ReviewApproved, time.Now())
	require.NoError(t, err)
	v3, third := up("cut v3", "coral://artifacts/"+v2, "&no_review=1")
	tags, err = rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.NotContains(t, tags[v3], "for review")
	assert.Equal(t, false, third["for_review"])
}

// #20401: the newest version is sent for review WITHOUT new bytes (the upload refuses the same bytes), idempotently; a decided file starts a new round; only the owning team's agent may; and an older version's
// digest names the file, the newest version is the one sent.
func TestAnAgentSendsTheNewestVersionForReviewWithoutNewBytes(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	up := func(text, ref string) string {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id=a1", strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "cut.html")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	review := func(session, id, body string) (int, map[string]any) {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts/"+id+"/review?session_id="+session, strings.NewReader(body))
		require.NoError(t, err)
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	v1 := up("cut v1", "")
	v2 := up("cut v2", "coral://artifacts/"+v1)
	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.NotContains(t, tags[v2], "for review", "uploaded with no tag, as in the report")

	code, out := review("a1", v1, `{"question":"Is the new cut good?"}`) // an older version's digest names the file
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "coral://artifacts/"+v2, out["uri"], "the newest version is the one sent")
	assert.Equal(t, true, out["for_review"])
	tags, _ = rig.h.bs.ArtifactTags(ctx, "team-a")
	assert.Contains(t, tags[v2], "for review")
	qs, _ := rig.h.bs.ArtifactQuestions(ctx, "team-a")
	assert.Equal(t, "Is the new cut good?", qs[v2].Question)

	code, out = review("a1", v2, ``) // again: nothing changes, nothing is refused
	require.Equal(t, http.StatusOK, code, out)
	tags2, _ := rig.h.bs.ArtifactTags(ctx, "team-a")
	assert.Equal(t, tags, tags2, "idempotent")

	_, _, err = rig.h.bs.DecideArtifactReview(ctx, "team-a", v2, board.ReviewApproved, time.Now())
	require.NoError(t, err)
	code, out = review("a1", v2, ``) // a decided file starts a new round
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "approved", out["again_after"])
	tags, _ = rig.h.bs.ArtifactTags(ctx, "team-a")
	assert.Contains(t, tags[v2], "for review")
	assert.NotContains(t, tags[v2], "approved")

	code, _ = review("b1", v2, ``) // another team's agent
	assert.Equal(t, http.StatusNotFound, code, "another team's file is not found for it")
	code, _ = review("n1", v2, ``) // an agent on no team
	assert.Equal(t, http.StatusForbidden, code)
	code, _ = review("a1", strings.Repeat("0", 64), ``)
	assert.Equal(t, http.StatusNotFound, code)
}

// #20401 SHOULDs (Security, QA2): a denied file is not sent again by an agent's call (409, only a real new version returns it); an agent cannot re-send one file in a loop (429 after 5 in an hour);
// and an upload with no_review on a file whose older version is still waiting says that row is still in Needs you.
func TestAgentReviewResendRefusesDeniedAndCapsLoopsAndNoReviewSaysWhatIsStillWaiting(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	up := func(text, ref, query string) map[string]any {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id=a1"+query, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "cut.html")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	hexOf := func(out map[string]any) string { return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/") }
	review := func(id string) (int, map[string]any) {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts/"+id+"/review?session_id=a1", strings.NewReader(``))
		require.NoError(t, err)
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// no_review with an older version still waiting: it stays, and the answer says so
	w1 := hexOf(up("w1", "", "&tag=for+review&question=Ok%3F"))
	out := up("w2", "coral://artifacts/"+w1, "&no_review=1")
	assert.Equal(t, false, out["for_review"])
	assert.Equal(t, "coral://artifacts/"+w1, out["earlier_version_waiting"])
	assert.Contains(t, out["inbox"], "STILL there")

	// denied: refused with a reason
	d1 := hexOf(up("d1", "", "&tag=for+review&question=Ok%3F"))
	_, _, err := rig.h.bs.DecideArtifactReview(ctx, "team-a", d1, board.ReviewDenied, time.Now())
	require.NoError(t, err)
	code, body := review(d1)
	assert.Equal(t, http.StatusConflict, code, body)
	assert.Equal(t, "denied", body["code"])
	tags, _ := rig.h.bs.ArtifactTags(ctx, "team-a")
	assert.Contains(t, tags[d1], board.ReviewDenied, "still denied")

	// the loop cap: 5 sends of one file an hour, then 429
	l1 := hexOf(up("l1", "", "&tag=for+review&question=Ok%3F"))
	for i := 0; i < reviewResendsPerHour; i++ {
		code, body = review(l1)
		require.Equal(t, http.StatusOK, code, body)
	}
	code, body = review(l1)
	assert.Equal(t, http.StatusTooManyRequests, code, body)
	assert.Equal(t, "resend_limit", body["code"])
}
