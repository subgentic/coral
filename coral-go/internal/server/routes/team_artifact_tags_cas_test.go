package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13129 (QA Reviewer 2's SHOULD on #13117): a Hub write is worked out from the stored tags it read; a local tag edit that lands between that read and the write must not be overwritten by it.
func TestAHubReadMarkNeverOverwritesALocalTagEditThatLandedAfterItsRead(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	withLabel(t, ownerLabel, nil)
	ctx := context.Background()
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"a"}))
	put := func(body string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/tags", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range ownerHeaders(ownerLabel) {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	stored := func() []string {
		all, err := e.h.bs.ArtifactTags(ctx, "tag-team")
		require.NoError(t, err)
		return all[id]
	}
	t.Cleanup(func() { hubTagsAfterRead = func() {} })

	// a local edit lands once, right after the Hub write's read: the Hub's list is judged again against the new list, which its request no longer matches (it would drop "approved"), so it is refused and the edit stays
	fired := 0
	hubTagsAfterRead = func() {
		if fired++; fired == 1 {
			require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"a", "approved"}))
		}
	}
	code, out := put(`{"tags":["a","read"]}`)
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, []string{"a", "approved"}, stored(), "the local edit was not overwritten")

	// a local change the request is still fine with (the file was marked read here too): judged again, written once, and the answer is the stored list
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"a"}))
	fired = 0
	hubTagsAfterRead = func() {
		if fired++; fired == 1 {
			require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"a", "read"}))
		}
	}
	code, out = put(`{"tags":["a","read"]}`)
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, 2, fired, "judged again after the change")
	assert.Equal(t, []string{"a", "read"}, stored())

	// a list that keeps changing under every attempt (read flipped each time) is a 409 after a few tries, never a stale write
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"a"}))
	n := 0
	hubTagsAfterRead = func() {
		n++
		next := []string{"a"}
		if n%2 == 1 {
			next = []string{"a", "read"}
		}
		require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, next))
	}
	code, out = put(`{"tags":["a","read"]}`)
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, hubTagsRetries+1, n)
}

func TestSetArtifactTagsIfWritesOnlyWhenTheTagsAreWhatWasRead(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	ctx := context.Background()
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, []string{"a", "b"}))
	stored := func() []string {
		all, err := e.h.bs.ArtifactTags(ctx, "tag-team")
		require.NoError(t, err)
		return all[id]
	}
	err := e.h.bs.SetArtifactTagsIf(ctx, "tag-team", id, []string{"a"}, []string{"a", "read"})
	assert.ErrorIs(t, err, board.ErrArtifactTagsChanged, "a stale read is refused")
	assert.Equal(t, []string{"a", "b"}, stored(), "and nothing is written")
	assert.ErrorIs(t, e.h.bs.SetArtifactTagsIf(ctx, "tag-team", id, []string{"a", "b", "c"}, nil), board.ErrArtifactTagsChanged)
	require.NoError(t, e.h.bs.SetArtifactTagsIf(ctx, "tag-team", id, []string{"b", "a", "a"}, []string{"a", "b", "read"}), "the same set in another order is the same read")
	assert.Equal(t, []string{"a", "b", "read"}, stored())
	// an object with no tags is a read of the empty set
	assert.ErrorIs(t, e.h.bs.SetArtifactTagsIf(ctx, "tag-team", id, nil, []string{"x"}), board.ErrArtifactTagsChanged)
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", id, nil))
	require.NoError(t, e.h.bs.SetArtifactTagsIf(ctx, "tag-team", id, nil, []string{"read"}))
}
