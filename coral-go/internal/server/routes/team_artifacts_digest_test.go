package routes

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13971: an exact-digest filter on the cross-team list, for one file's review state without scanning pages.
func TestTheDigestFilterAnswersExactlyTheFilesAskedFor(t *testing.T) {
	p := newPinnedRig(t)
	_, d := threeVersions(t, p.k)
	digestsOf := func(query string) []string {
		code, out := p.get(t, "/api/team-artifacts?"+query, nil)
		require.Equal(t, http.StatusOK, code, out)
		var ds []string
		for _, a := range out["artifacts"].([]any) {
			ds = append(ds, strings.TrimPrefix(a.(map[string]any)["digest"].(string), "sha256:"))
		}
		return ds
	}
	assert.ElementsMatch(t, []string{d[2]}, digestsOf("digest="+d[2]), "one file")
	assert.ElementsMatch(t, []string{d[0], d[2]}, digestsOf("digest="+d[0]+"&digest="+d[2]), "a few, repeated")
	assert.ElementsMatch(t, []string{d[0], d[1]}, digestsOf("digest="+d[0]+","+d[1]), "or comma-separated")
	assert.ElementsMatch(t, []string{d[1]}, digestsOf("digest="+strings.ToUpper(d[1])), "case is folded")
	assert.Empty(t, digestsOf("digest="+strings.Repeat("e", 64)), "a digest nobody holds matches nothing")
	assert.Len(t, digestsOf("limit=50"), 3, "without it the list is as before: every version is a row")
	assert.ElementsMatch(t, []string{d[2]}, digestsOf("digest="+d[2]+"&tag=for+review&waiting=1"), "it composes with the other filters")
	assert.Empty(t, digestsOf("digest="+d[2]+"&tag=approved"), "and only narrows")
	assert.ElementsMatch(t, []string{d[2]}, digestsOf("digest="+d[2]+"&digest="+d[1]+"&tag=for+review"), "d[1] is a version that is not tagged for review")
}

func TestTheDigestFilterIsCappedStrictAndOnTheCrossTeamListAlone(t *testing.T) {
	p := newPinnedRig(t)
	_, d := threeVersions(t, p.k)
	for name, q := range map[string]string{
		"too short":        "digest=abc",
		"not hex":          "digest=" + strings.Repeat("z", 64),
		"a prefix link":    "digest=coral://artifacts/" + d[0],
		"an empty value":   "digest=",
		"a wildcard":       "digest=" + url.QueryEscape("%"),
		"twenty-one of it": "digest=" + strings.Join(manyDigests(21), ","),
	} {
		code, _ := p.get(t, "/api/team-artifacts?"+q, nil)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
	code, _ := p.get(t, "/api/team-artifacts?digest="+strings.Join(manyDigests(20), ","), nil)
	assert.Equal(t, http.StatusOK, code, "twenty are allowed")
	code, _ = p.get(t, "/api/board/alpha/artifacts?digest="+d[0], nil)
	assert.Equal(t, http.StatusBadRequest, code, "the per-board list refuses it: the cross-team list is the owner-protected one")
}

// The owner-only rules of #13910 hold on a digest-filtered read: the Operator gets the star fields, an agent's token gets none.
func TestADigestFilteredReadKeepsTheOwnerOnlyFields(t *testing.T) {
	p := newPinnedRig(t)
	_, d := threeVersions(t, p.k)
	p.star(t, d[0], "2026-11-06T10:00:00Z")
	_, out := p.get(t, "/api/team-artifacts?digest="+d[2], nil)
	row := out["artifacts"].([]any)[0].(map[string]any)
	assert.Equal(t, true, row["starred"], "the Operator: starred, following the series")
	assert.Contains(t, row, "starred_at")
	assert.Contains(t, row, "series_id")
	assert.Equal(t, "alpha", row["board_id"], "with its team's identity")
	assert.NotEmpty(t, row["source"], "and its source")
	assert.False(t, starVisible(withActor(httptest.NewRequest("GET", "/x", nil), Actor{Kind: ActorToken, Name: "Backend", Session: "s1"})), "an agent's token never sees them")
}

func manyDigests(n int) []string {
	var out []string
	for i := 0; i < n; i++ {
		out = append(out, strings.Repeat(string(rune('a'+i%6)), 62)+string(rune('0'+i/10))+string(rune('0'+i%10)))
	}
	return out
}
