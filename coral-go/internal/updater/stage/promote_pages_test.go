package stage

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15476: #15414 (a streamed, capped read of the API's releases list) and #15081 (the promotion found in the promotion tags) both rewrote the one function. #15081 reads no releases list at all, so
// #15414's streaming is not merged; these two tests pin what #15414 was for.

// DevOps's #14535 finding: every promote-* row sat on page 3. The tags are asked a page at a time, so a promotion only on page 3 is found.
func TestAPromotionOnlyOnThirdPageOfTheTagsIsFound(t *testing.T) {
	e := newEnv(t, "1.4.125")
	page := func(first, n, seq int) string {
		var tags []string
		for i := 0; i < n; i++ {
			tags = append(tags, fmt.Sprintf("promote-v1.2.%d-%d", first+i, seq)) // older promotions: the fake answers their downloads with the real manifest, which names another tag
		}
		return refsAnswer(tags...)
	}
	e.rel.pages = map[int]string{
		1: page(0, refsPerPage, 1),
		2: page(refsPerPage, refsPerPage, 2),
		3: refsAnswer("promote-v1.4.130-7"), // the real promotion, alone on the last page
	}
	res := e.check()
	require.Equal(t, ResultStaged, res.Result, "%+v", res)
	assert.Equal(t, "1.4.130", res.Version, "the promotion on page 3 is found")
}

// The 1.3 MB list of 2026-11-10 was the repository's releases with their notes. The check's list is the promotion tags, and the default is the production one: a pin, so a later merge cannot put the releases list back.
func TestTheProductionListIsThePromotionTagsAndNotTheReleasesList(t *testing.T) {
	assert.Contains(t, ReleasesList, "/git/matching-refs/tags/promote-")
	assert.False(t, strings.Contains(ReleasesList, "/releases"), "the releases list (30 releases with their notes, 1.26 MB on 2026-11-10) is never asked: %s", ReleasesList)
	assert.LessOrEqual(t, maxRefsPages*refsPerPage, 1000, "a bounded number of tags is read")
}
