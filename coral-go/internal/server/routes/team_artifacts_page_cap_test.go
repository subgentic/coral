package routes

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #13161 (the Operator: 'we only need to paginate the uploads. A computer doesn't need to return more than the first 50'): every artifact list route answers at most 50 items per request, however big a limit is asked
// for, with has_more and a cursor; the next page continues without a gap or a repeat even when an upload lands in between; a filter is applied over every item before the page is cut.
func taPage(t *testing.T, e *taEnv, path string) (reply taReply, raw map[string]any) {
	t.Helper()
	resp, err := http.Get(e.srv.URL + path)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	require.Equal(t, 200, resp.StatusCode, path+" "+string(b))
	require.NoError(t, json.Unmarshal(b, &reply))
	_ = json.Unmarshal(b, &raw)
	return reply, raw
}

func seedFiles(e *taEnv, n int) {
	for i := 0; i < n; i++ {
		e.upload(sessAlice, fmt.Sprintf("bulk-%04d.md", i), fmt.Sprintf("body %d", i), "text/markdown", time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC).Add(time.Duration(i)*time.Minute).Format(time.RFC3339))
	}
}

func TestArtifactListsNeverReturnMoreThanFifty(t *testing.T) {
	e := newTAEnv(t)
	seedFiles(e, 130)
	for _, path := range []string{
		"/api/board/alpha/artifacts?limit=200",                  // the plain list, a big limit
		"/api/board/alpha/artifacts",                            // no limit at all
		"/api/board/alpha/artifacts?limit=200&versions=newest",  // a query
		"/api/board/alpha/artifacts?limit=200&tag=for%20review", // the Needs you read
		"/api/team-artifacts?limit=200&versions=newest",         // the cross-team list
		"/api/team-artifacts",
	} {
		got, _ := taPage(t, e, path)
		require.LessOrEqual(t, len(got.Artifacts), 50, "%s returns at most 50", path)
	}
	got, _ := taPage(t, e, "/api/board/alpha/artifacts?limit=200&versions=newest")
	require.Len(t, got.Artifacts, 50, "a list of 130 files answers a full page of 50")
	require.True(t, got.HasMore, "and says there is more")
	require.NotEmpty(t, got.NextCursor, "with a cursor to ask for it")
	require.NotNil(t, got.Total, "and the filtered total")
	require.GreaterOrEqual(t, *got.Total, 130)
}

func TestNextPageContinuesWithoutGapsOrRepeatsWhenAnUploadLandsBetween(t *testing.T) {
	e := newTAEnv(t)
	seedFiles(e, 130)
	var names []string
	cursor := ""
	for page := 0; page < 20; page++ {
		path := "/api/board/alpha/artifacts?limit=50&versions=newest&sort=newest"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		got, raw := taPage(t, e, path)
		for _, a := range got.Artifacts {
			names = append(names, a.Name)
		}
		if page == 0 {
			// an upload lands between page 1 and page 2: the newest of all
			e.upload(sessAlice, "landed-between.md", "late", "text/markdown", "2026-12-01T00:00:00Z")
		}
		if !got.HasMore {
			break
		}
		next, _ := raw["next_cursor"].(string)
		require.NotEmpty(t, next)
		cursor = url.QueryEscape(next)
	}
	seen := map[string]int{}
	for _, n := range names {
		seen[n]++
		require.Equal(t, 1, seen[n], "%s appears once: no repeat when an upload lands between the pages", n)
	}
	for i := 0; i < 130; i++ {
		require.Contains(t, seen, fmt.Sprintf("bulk-%04d.md", i), "no gap: bulk-%04d.md is in the pages", i)
	}
}

func TestAMatchPastTheFirstPageIsFoundOnPageOneOfItsQuery(t *testing.T) {
	e := newTAEnv(t)
	seedFiles(e, 900)
	got, _ := taPage(t, e, "/api/board/alpha/artifacts?limit=50&versions=newest&q=bulk-0003")
	require.Len(t, got.Artifacts, 1, "the file that is item 897 of 900 by date is on page 1 of its own query")
	require.Equal(t, "bulk-0003.md", got.Artifacts[0].Name)
	require.False(t, got.HasMore)
	require.NotNil(t, got.Total)
	require.Equal(t, 1, *got.Total, "the filtered total is the match count")
}

// The Hub only passes a cursor that is unpadded base64url, at most 1024 bytes (the Orchestrator for coral-hub): every cursor this route issues is that, for every sort, even for a file with a very long name (a cursor
// that the route itself refused on its way back, 'long', would end the paging at page 1 for that list).
func TestNextCursorIsUnpaddedBase64urlAndShortForEverySort(t *testing.T) {
	e := newTAEnv(t)
	long := ""
	for i := 0; i < 900; i++ {
		long += "n"
	}
	for i := 0; i < 60; i++ {
		e.upload(sessAlice, fmt.Sprintf("%s-%03d.md", long, i), fmt.Sprintf("body %d", i), "text/markdown", time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC).Add(time.Duration(i)*time.Minute).Format(time.RFC3339))
	}
	for _, sortName := range []string{"newest", "oldest", "name", "name_desc", "size", "size_asc", "type", "type_desc", "tags", "tags_desc", "uploader", "uploader_desc"} {
		got, raw := taPage(t, e, "/api/board/alpha/artifacts?limit=50&versions=newest&sort="+sortName)
		require.True(t, got.HasMore, sortName)
		next, _ := raw["next_cursor"].(string)
		require.NotEmpty(t, next, sortName)
		require.LessOrEqual(t, len(next), 1024, "%s: the cursor is at most 1024 bytes", sortName)
		require.Regexp(t, `^[A-Za-z0-9_-]+$`, next, "%s: unpadded base64url", sortName)
		again, _ := taPage(t, e, "/api/board/alpha/artifacts?limit=50&versions=newest&sort="+sortName+"&cursor="+url.QueryEscape(next))
		require.NotEmpty(t, again.Artifacts, "%s: the cursor it issued is one it accepts", sortName)
	}
}
