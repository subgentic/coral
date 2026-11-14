package routes

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16337 (the #16309 class): the enforce flag is the process's, so a top-level test that runs in parallel and sets it turns it on under every other parallel test, and any of them that makes an
// unverified attributed request gets a 403 identity_unverified (six did). A test that sets the flag is not parallel at the top level (its subtests may be: it then has the package to itself).
func TestNoParallelTopLevelTestSetsTheEnforceFlag(t *testing.T) {
	files, err := filepath.Glob("*_test.go")
	require.NoError(t, err)
	fn := regexp.MustCompile(`(?m)^func (Test\w+)\(t \*testing\.T\) \{\n`)
	var bad []string
	for _, f := range files {
		raw, err := os.ReadFile(f)
		require.NoError(t, err)
		src := string(raw)
		idx := fn.FindAllStringSubmatchIndex(src, -1)
		for i, m := range idx {
			end := len(src)
			if i+1 < len(idx) {
				end = idx[i+1][0]
			}
			body := src[m[1]:end]
			head := body
			if n := strings.Index(body, "\n\t"+"t.Run("); n >= 0 {
				head = body[:n]
			}
			// parallel at the top level: t.Parallel() as one of the test's own first statements (before any t.Run)
			parallel := regexp.MustCompile(`(?m)^\tt\.Parallel\(\)`).MatchString(head)
			if parallel && strings.Contains(body, "setIdentityActorEnforced(") {
				bad = append(bad, f+": "+src[m[2]:m[3]])
			}
		}
	}
	assert.Empty(t, bad, "a parallel top-level test sets the process-wide enforce flag (#16337)")
}
