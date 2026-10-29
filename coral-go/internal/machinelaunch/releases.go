package machinelaunch

import (
	"fmt"
	"regexp"
)

// ReleaseDigests are the SHA-256 digests of one Coral release's Linux tarballs, pinned in this CLI (#10919, coral-hub Lead's read of the launch design): the machine checks the tarball it downloads against the digest
// the launcher passes in the user-data (a digest is not a secret), never against a SHA256SUMS fetched from the same place at boot, so a swapped download and a swapped list cannot agree.
type ReleaseDigests struct {
	AMD64 string // coral-linux-amd64-<version>.tar.gz
	ARM64 string // coral-linux-arm64-<version>.tar.gz
}

// releaseDigests is the table of released versions. A release adds its line (tools: copy the two Linux lines of the release's SHA256SUMS.txt AFTER checking that file's Sigstore bundle); a version that is not here can
// be launched only with --coral-sha256-amd64 and --coral-sha256-arm64 given by the person, from a SHA256SUMS they checked.
var releaseDigests = map[string]ReleaseDigests{
	// 2.0.3: the two Linux lines of the v2.0.3 release's SHA256SUMS.txt, read over HTTPS from the release on 2026-10-29. Check them against the release's Sigstore bundle before relying on them.
	"2.0.3": {
		AMD64: "77a3abd92470cddd33fd3c66bfe15729f1695d75a340373bd620dfc7290a29da",
		ARM64: "d09d630ce2608d45368935185f3fb0e57f6cdaf1397eebb66600480c3629d93c",
	},
}

var sha256HexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// PinnedReleaseDigests is the pinned digests for a Coral version, or false when this CLI has none for it.
func PinnedReleaseDigests(version string) (ReleaseDigests, bool) {
	d, ok := releaseDigests[version]
	return d, ok
}

// Valid reports whether both digests are 64 lower-case hex digits.
func (d ReleaseDigests) Valid() error {
	if !sha256HexRe.MatchString(d.AMD64) || !sha256HexRe.MatchString(d.ARM64) {
		return fmt.Errorf("the Coral release digests are not two SHA-256 values (64 lower-case hex digits each)")
	}
	return nil
}
