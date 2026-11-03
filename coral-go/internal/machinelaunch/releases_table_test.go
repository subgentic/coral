package machinelaunch

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

// coral-hub's table test (their slice 7q, read in #12623), kept because it holds whatever rows the table ever has: every pinned release is a plain version with two valid, distinct digests that no other
// release shares (a copy-paste of one release's line under another version would pin the wrong download).
func TestEveryPinnedReleaseIsAPlainVersionWithTwoDistinctValidDigestsNobodyElseShares(t *testing.T) {
	if len(releaseDigests) == 0 {
		t.Fatal("the table is empty")
	}
	plain := regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	seen := map[string]string{}
	for v, d := range releaseDigests {
		if !plain.MatchString(v) {
			t.Errorf("%q is not a plain version", v)
		}
		if err := d.Valid(); err != nil {
			t.Errorf("%s: %v", v, err)
		}
		if d.AMD64 == d.ARM64 {
			t.Errorf("%s: the two architectures share a digest", v)
		}
		for _, h := range []string{d.AMD64, d.ARM64} {
			if o, dup := seen[h]; dup {
				t.Errorf("%s and %s share the digest %s", o, v, h)
			}
			seen[h] = v
		}
	}
}

// A launch of a version the table does not have is refused (the build cannot hold its own release's digest, which does not exist until the release is made), and the refusal names what IS pinned, so the
// person can choose one or give the digests of a release they checked (#12623).
func TestPinnedVersionsAreListedSortedAndTheLaunchRefusalNamesThem(t *testing.T) {
	got := PinnedVersions()
	if len(got) != len(releaseDigests) || !sort.StringsAreSorted(got) {
		t.Fatalf("every pinned version, sorted: %v", got)
	}
	for _, v := range got {
		if _, ok := PinnedReleaseDigests(v); !ok {
			t.Errorf("%s is listed but not pinned", v)
		}
	}
	words := NoPinnedDigestWords("9.9.9", false)
	if !strings.Contains(words, "9.9.9") || !strings.Contains(words, "--coral-sha256-amd64") || !strings.Contains(words, strings.Join(got, ", ")) {
		t.Errorf("the refusal names the version, the way out and the pinned versions: %q", words)
	}
}

// The build's own version with no row (the newest CLI, always) says it is too new to pin and to pass --coral-version of a pinned one (#12623, Security); a version the person asked for does not say "too new".
func TestTheBuildsOwnVersionWithNoRowSaysItIsTooNewForThisBuildToPin(t *testing.T) {
	own := NoPinnedDigestWords("9.9.9", true)
	for _, want := range []string{"9.9.9", "this build's own release", "too new for this build to pin", "--coral-version", strings.Join(PinnedVersions(), ", "), "--coral-sha256-amd64"} {
		if !strings.Contains(own, want) {
			t.Errorf("the own-version refusal lacks %q: %q", want, own)
		}
	}
	if asked := NoPinnedDigestWords("9.9.9", false); strings.Contains(asked, "too new") || strings.Contains(asked, "own release") {
		t.Errorf("a version the person asked for is not 'too new': %q", asked)
	}
}
