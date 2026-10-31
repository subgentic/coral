package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11553, the Operator's rule: an agent cannot tag for review what Needs you cannot show inline. The upload with --tag "for review" of a patch or a binary is refused (400, not_viewable) and
// nothing is stored; the same file without the tag is stored (a .patch as text); Markdown, an image-free text file and a PDF still go through; and a stored row of that kind that already carries
// the tag leaves the list of "for review" rows.
func TestForReviewIsRefusedForWhatNeedsYouCannotShow(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	up := func(session, name, mediaType, text string, tags ...string) (int, map[string]any) {
		q := ""
		for _, tg := range tags {
			q += "&tag=" + strings.ReplaceAll(tg, " ", "+")
		}
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id="+session+q, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", name)
		if mediaType != "" {
			req.Header.Set("X-Artifact-Media-Type", mediaType)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	ok := func(code int) bool { return code == http.StatusOK || code == http.StatusCreated }

	// A binary, or a file whose type says nothing and whose name does not either, is refused with the tag, and the answer says why and what to do.
	code, out := up("a1", "blob.bin", "application/zip", "PK", "for review")
	require.Equal(t, http.StatusBadRequest, code, out)
	assert.Equal(t, "not_viewable", out["code"])
	assert.Contains(t, out["error"], "cannot be tagged")
	assert.Contains(t, out["error"], "without --tag")
	code, out = up("a1", "dump.dat", "application/octet-stream", "\x00\x01", "For  Review")
	require.Equal(t, http.StatusBadRequest, code, "the tag in another spelling is the same tag: %v", out)
	code, out = up("a1", "dump2", "", "\x00\x01", "for review")
	require.Equal(t, http.StatusBadRequest, code, "no name that says what it is, no declared type: %v", out)
	// A patch is text now (stored as text/plain whatever the CLI declared), which Needs you can show: the type is what decides, not the word "patch".
	code, out = up("a1", "fix.patch", "application/octet-stream", "diff --git a/x b/x\n", "for review")
	require.True(t, ok(code), out)
	assert.Equal(t, "text/plain; charset=utf-8", out["media_type"])

	// Without the tag it is stored, as text.
	code, out = up("a1", "plain.patch", "application/octet-stream", "diff --git a/y b/y\n")
	require.True(t, ok(code), out)
	assert.Equal(t, "text/plain; charset=utf-8", out["media_type"])
	code, _ = up("a1", "blob2.bin", "application/zip", "PK2", "internal")
	assert.True(t, ok(code), "another tag is not the rule's business")

	// What Needs you can show still goes through with the tag.
	for _, c := range []struct{ name, mt string }{{"spec.md", ""}, {"plan.html", "text/html"}, {"table.csv", "text/csv"}, {"doc.pdf", "application/pdf"}, {"notes.txt", "application/octet-stream"}} {
		code, out = up("a1", c.name, c.mt, "content of "+c.name, "for review")
		assert.True(t, ok(code), "%s: %v", c.name, out)
	}

	// A row that already carries the tag and cannot be shown (stored before this rule) leaves the list of "for review" rows.
	ctx := context.Background()
	code, out = up("a1", "old.bin", "application/zip", "PK-old")
	require.True(t, ok(code), out)
	oldID := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	_, err := rig.h.bs.AddArtifactTags(ctx, "team-a", oldID, []string{"for review", "internal"})
	require.NoError(t, err)
	items := []teamArtifact{{managed: oldID, Name: "old.bin", MediaType: "application/zip"}, {managed: oldID + "x", Name: "x.md", MediaType: "text/markdown"}}
	bhTags := &BoardHandler{bs: rig.h.bs}
	bhTags.attachArtifactTags(ctx, "team-a", items)
	assert.Equal(t, []string{"internal"}, items[0].Tags, "the unviewable row keeps its other tags and loses 'for review'")
}
