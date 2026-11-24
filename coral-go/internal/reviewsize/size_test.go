package reviewsize

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

// Review size guard, Warn mode (#21022, brief task 3): lines and/or files over a limit, with skip paths that are not counted. A warning only.

func files() []File {
	return []File{
		{Path: "internal/a.go", Added: 300, Deleted: 100},
		{Path: "internal/b.go", Added: 200, Deleted: 0},
		{Path: "go.sum.lock", Added: 150, Deleted: 50},
		{Path: "pkg/generated/x.go", Added: 40, Deleted: 0},
		{Path: "tests/golden/out.txt", Added: 22, Deleted: 0},
	}
}

func TestUnderBothLimitsIsNotOver(t *testing.T) {
	r := Check(files(), Limits{Lines: 800, Files: 20, Skip: []string{"*.lock", "**/generated/**", "tests/golden/**"}})
	require.False(t, r.Over)
	require.Equal(t, 600, r.Lines, "added plus deleted of the counted files")
	require.Equal(t, 2, r.Files)
	require.Equal(t, 262, r.SkippedLines)
	require.Equal(t, 3, r.SkippedFiles)
}

func TestOverLinesOrOverFiles(t *testing.T) {
	require.True(t, Check(files(), Limits{Lines: 500, Skip: []string{"*.lock", "**/generated/**", "tests/golden/**"}}).Over)
	require.True(t, Check(files(), Limits{Files: 4}).Over, "5 files with nothing skipped is over 4")
	require.False(t, Check(files(), Limits{Files: 5}).Over, "at the limit is not over")
}

func TestAZeroLimitIsOffAndNoLimitsIsNeverOver(t *testing.T) {
	require.False(t, Check(files(), Limits{}).Over)
	require.True(t, Check(files(), Limits{Lines: 10}).Over)
	require.False(t, Check(files(), Limits{Lines: 0, Files: 100}).Over)
}

func TestSkipPatterns(t *testing.T) {
	for _, c := range []struct {
		pat, path string
		want      bool
	}{
		{"*.lock", "go.sum.lock", true},
		{"*.lock", "deep/dir/yarn.lock", true}, // a bare file pattern matches in any folder
		{"**/generated/**", "pkg/generated/x.go", true},
		{"**/generated/**", "generated/x.go", true},
		{"tests/golden/**", "tests/golden/a/b.txt", true},
		{"tests/golden/**", "xtests/golden/a.txt", false},
		{"tests/golden/**", "tests/golden", false},
		{"*.lock", "lockfile.go", false},
		{"docs/*.md", "docs/a.md", true},
		{"docs/*.md", "docs/sub/a.md", false},
		{"a?c.go", "abc.go", true},
		{"", "anything", false},
	} {
		require.Equal(t, c.want, matches(c.pat, c.path), "%q vs %q", c.pat, c.path)
	}
}

func TestParseSkipListTrimsAndDropsEmpties(t *testing.T) {
	require.Equal(t, []string{"*.lock", "**/generated/**"}, ParseSkip(" *.lock, ,**/generated/** ,"))
	require.Nil(t, ParseSkip(""))
	require.Len(t, ParseSkip("a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,a1,b1,c1,d1,e1,f1,g1,h1,i1,j1,k1,l1,m1,n1,o1,p1,q1,r1,s1,t1,u1,v1,w1,x1,y1,z1"), 50, "a list is capped at 50 patterns")
}

func TestBinaryFilesCountAsFilesNotLines(t *testing.T) {
	r := Check([]File{{Path: "logo.png", Binary: true}, {Path: "a.go", Added: 5}}, Limits{Files: 1})
	require.True(t, r.Over)
	require.Equal(t, 5, r.Lines)
}

// Brief task 10 (#21059): what the team does with a change over the limit. Warn is the default; Send back and Split add a button to the banner, and the verdict carries the words for it.
func TestOverLimitModeDefaultsToWarnAndRefusesUnknown(t *testing.T) {
	s, err := Setting{On: true, Lines: 800}.Validate()
	require.NoError(t, err)
	require.Equal(t, ModeWarn, s.OverLimit, "no mode saved: Warn")
	for _, m := range []string{ModeWarn, ModeSendBack, ModeSplit} {
		got, err := Setting{On: true, Lines: 800, OverLimit: m}.Validate()
		require.NoError(t, err)
		require.Equal(t, m, got.OverLimit)
	}
	_, err = Setting{On: true, Lines: 800, OverLimit: "delete"}.Validate()
	require.Error(t, err, "a mode that is not one of the three is refused")
}

func TestVerdictCarriesTheModeAndItsWords(t *testing.T) {
	big := []File{{Path: "a.go", Added: 1356, Deleted: 486}}
	for i := 0; i < 30; i++ {
		big = append(big, File{Path: fmt.Sprintf("f%d.go", i)})
	}
	set := Setting{On: true, Lines: 800, Files: 20, OverLimit: ModeSendBack}
	v := set.Verdict("Frontend Dev 2", big)
	require.True(t, v.Over)
	require.Equal(t, ModeSendBack, v.OverLimit)
	require.Contains(t, v.SendBackNote, "1,842 lines in 31 files", "the change's size, with thousands separated")
	require.Contains(t, v.SendBackNote, "800 lines or 20 files", "names the limit")
	require.Contains(t, v.SendBackNote, "split", "asks for a split")

	set.OverLimit = ModeSplit
	v = set.Verdict("Frontend Dev 2", big)
	require.Empty(t, v.SendBackNote)
	require.Equal(t, "Split #20844 (1,842 lines in 31 files, limit 800 lines or 20 files) into follow-up tasks under the limit.", v.SplitAskFor(20844))

	set.OverLimit = ModeWarn
	v = set.Verdict("Frontend Dev 2", big)
	require.Equal(t, ModeWarn, v.OverLimit)
	require.Empty(t, v.SendBackNote)

	under := set.Verdict("Frontend Dev 2", []File{{Path: "a.go", Added: 10}})
	require.Empty(t, under.OverLimit, "a change under the limit has no action")
}
