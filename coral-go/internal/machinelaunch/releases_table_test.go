package machinelaunch

import (
	"regexp"
	"testing"
)

// #9934 round 1, item 4: the releases a person can run this CLI from today must be launchable with pinned digests (a version without them needs --coral-sha256-* from the person).
func TestTheShippedReleasesAreLaunchableWithPinnedDigests(t *testing.T) {
	for _, v := range []string{"2.0.3", "2.0.34", "2.0.35", "2.0.36", "2.0.37"} {
		d, ok := PinnedReleaseDigests(v)
		if !ok {
			t.Errorf("no pinned digests for %s", v)
			continue
		}
		if err := d.Valid(); err != nil {
			t.Errorf("%s: %v", v, err)
		}
		if d.AMD64 == d.ARM64 {
			t.Errorf("%s: the two architectures share a digest", v)
		}
	}
}

func TestEveryPinnedReleaseIsAPlainVersionWithTwoDistinctValidDigestsNobodyElseShares(t *testing.T) {
	plain := regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	seen := map[string]string{}
	for v, d := range releaseDigests {
		if !plain.MatchString(v) {
			t.Errorf("%q is not a plain version", v)
		}
		if err := d.Valid(); err != nil {
			t.Errorf("%s: %v", v, err)
		}
		for _, h := range []string{d.AMD64, d.ARM64} {
			if o, dup := seen[h]; dup {
				t.Errorf("%s and %s share the digest %s", o, v, h)
			}
			seen[h] = v
		}
	}
}
