package stage

import (
	"bytes"
	"fmt"
	"log"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15080 part 2: the promotion is found in the repository's promotion tags (a small answer), never in the list of its newest releases, which by then was over the 1 MB cap and read as a network failure.

// refsAnswer is GitHub's matching-refs answer for "promote-": one entry per tag, in the alphabet's order (not the newest first), as a real one is, with the object block each ref carries.
func refsAnswer(tags ...string) string {
	var b strings.Builder
	b.WriteString("[")
	for i, t := range tags {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"ref":"refs/tags/%s","node_id":"REF_kwDOabcdefghijklmnop","url":"https://api.github.com/repos/subgentic/coral/git/refs/tags/%s","object":{"sha":"%s","type":"commit","url":"https://api.github.com/repos/subgentic/coral/git/commits/%s"}}`,
			t, t, strings.Repeat("ab", 20), strings.Repeat("ab", 20))
	}
	b.WriteString("]")
	return b.String()
}

func TestThePromotionIsFoundInThePromotionTagsAndNotTheReleaseList(t *testing.T) {
	e := newEnv(t, "1.4.125")
	var tags []string
	for i := 0; i < 70; i++ { // seventy older promotions: alphabetically before and after the real one; none has files on the fake
		tags = append(tags, fmt.Sprintf("promote-v1.2.%d-%d", i, i%6+1)) // sequences 1 to 6; the real promotion is 7
	}
	tags = append(tags, "promote-v1.4.130-7", "promote-v1.4.99-3", "promote-v1.4.9-1") // "1.4.9" and "1.4.99" sort after "1.4.130" as text, before it as sequences
	e.rel.list = refsAnswer(tags...)

	res := e.check()
	require.Equal(t, ResultStaged, res.Result, "%+v", res)
	assert.Equal(t, "1.4.130", res.Version, "the newest promotion by sequence, not the last in the alphabet")
	assert.Equal(t, 0, e.rel.hitCount("releases"), "the list of releases is never asked")
}

func TestOnlyTheNewestPromotionsAreDownloadedWhateverTheListHolds(t *testing.T) {
	e := newEnv(t, "1.4.125")
	var tags []string
	for i := 1; i <= 300; i++ {
		tags = append(tags, fmt.Sprintf("promote-v1.1.%d-%d", i, i)) // the sequence rises with i: the newest is 300
	}
	e.rel.list = refsAnswer(tags...) // the fake answers every download with the real manifest, which names another tag: each candidate is refused
	res := e.check()
	assert.Equal(t, ResultFailed, res.Result, "%+v", res)
	assert.Equal(t, "1.1.300", res.Version, "the newest of the 300 is the one looked at first")
	assert.LessOrEqual(t, e.rel.hitCount("promote.json"), maxPromoteCandidates, "a long list costs no more than the newest %d downloads", maxPromoteCandidates)
}

func TestAnAnswerOverTheLimitIsTooLargeAndNotANetworkFailure(t *testing.T) {
	e := newEnv(t, "1.4.125")
	e.rel.list = refsAnswer("promote-v1.4.130-7") + strings.Repeat(" ", maxListBytes+1)
	res := e.check()
	require.Equal(t, ResultFailed, res.Result, "%+v", res)
	st := e.state()
	require.NotNil(t, st.Stage)
	assert.Equal(t, KindTooLarge, st.Stage.ErrorKind)
	assert.NotEmpty(t, st.Stage.NextAttempt, "it waits like any failure, and does not ask again at once")
}

func TestTheRealErrorOfAFailedCheckIsInTheLog(t *testing.T) {
	e := newEnv(t, "1.4.125")
	e.rel.status["/list"] = 502
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(log.Writer()) })
	res := e.check()
	require.Equal(t, ResultFailed, res.Result, "%+v", res)
	assert.Contains(t, buf.String(), "the check for a promotion failed")
	assert.Contains(t, buf.String(), "502", "what GitHub answered")
	assert.Equal(t, KindNetwork, e.state().Stage.ErrorKind, "an answer that is not too large stays a network failure")
}

// The sequence is the order the promotions were made in: a revocation of a newer product version is a promotion of an older tag with a later sequence, and it is the newest.
func TestTheNewestPromotionIsTheHighestSequenceWhateverItsVersion(t *testing.T) {
	assert.True(t, promoteNewer("promote-v1.4.131-8", "promote-v1.4.132-6"), "a revocation (older tag, later sequence) is newer")
	assert.False(t, promoteNewer("promote-v1.4.132-6", "promote-v1.4.131-8"))
	assert.True(t, promoteNewer("promote-v1.4.132-6", "promote-v1.4.131-6"), "the same sequence: the higher version")
	assert.True(t, promoteNewer("promote-v1.4.9-2", "junk"), "a tag that is not a promotion's goes last")
}
