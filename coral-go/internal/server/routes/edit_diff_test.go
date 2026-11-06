package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #13802: the line diff of a saved edit against the version before it.
func TestUnifiedHunksShowAChangedLineWithItsContext(t *testing.T) {
	out, ok := unifiedHunks("one\ntwo\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nfive\n")
	assert.True(t, ok)
	assert.Equal(t, "@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five", out)
	out, _ = unifiedHunks("a\nb\n", "a\nb\nc\n")
	assert.Equal(t, "@@ -1,2 +1,3 @@\n a\n b\n+c", out, "an added line")
	out, _ = unifiedHunks("a\nb\nc\n", "a\nc\n")
	assert.Equal(t, "@@ -1,3 +1,2 @@\n a\n-b\n c", out, "a removed line")
}

func TestFarApartChangesAreTwoHunksAndNearOnesOne(t *testing.T) {
	var old, nw []string
	for i := 0; i < 30; i++ {
		old = append(old, "line")
		nw = append(nw, "line")
	}
	nw[2], nw[25] = "changed early", "changed late"
	out, _ := unifiedHunks(strings.Join(old, "\n"), strings.Join(nw, "\n"))
	assert.Equal(t, 2, strings.Count(out, "@@ -"), "two hunks: %s", out)
	nw2 := append([]string{}, old...)
	nw2[10], nw2[13] = "x", "y"
	out, _ = unifiedHunks(strings.Join(old, "\n"), strings.Join(nw2, "\n"))
	assert.Equal(t, 1, strings.Count(out, "@@ -"), "changes within the context of each other join: %s", out)
}

func TestLineEndingsAloneAreNoVisibleChangeAndAHugeChangeIsTooBigToShow(t *testing.T) {
	out, ok := unifiedHunks("a\r\nb\r\n", "a\nb\n")
	assert.True(t, ok)
	assert.Equal(t, "", out, "only the line ends changed: no hunk")
	var a, b []string
	for i := 0; i < 3000; i++ {
		a = append(a, "old "+strings.Repeat("x", i%7)+string(rune('a'+i%26)))
		b = append(b, "new "+strings.Repeat("y", i%5)+string(rune('a'+i%26)))
	}
	_, ok = unifiedHunks(strings.Join(a, "\n"), strings.Join(b, "\n"))
	assert.False(t, ok, "3,000 changed lines against 3,000: over the comparison limit")
}
