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
	// 2.0.34: the two Linux lines of the v2.0.34 release's SHA256SUMS.txt, read over HTTPS from the release on 2026-11-03. NOT yet checked against the release's Sigstore bundle (no cosign where this was read): check before relying on them.
	"2.0.34": {
		AMD64: "0d0e25de9f0383bc763ba28565d3652b7d2e7116f8dd46983e281ebdb0557d05",
		ARM64: "5e738efbc72236ee5b5841822c0234e06e9d5c58f0115caffc44f816769c7895",
	},
	// 2.0.35: the two Linux lines of the v2.0.35 release's SHA256SUMS.txt, read over HTTPS from the release on 2026-11-03. NOT yet checked against the release's Sigstore bundle (no cosign where this was read): check before relying on them.
	"2.0.35": {
		AMD64: "79303830561141d39b597d2c322ed0f4d44a721c5e2d3f975012865a2d00ff34",
		ARM64: "d68073585c7076b52da1f7c1a112df137b9f3b4827ed39ec42e648fe136d3912",
	},
	// 2.0.36: the two Linux lines of the v2.0.36 release's SHA256SUMS.txt, read over HTTPS from the release on 2026-11-03. NOT yet checked against the release's Sigstore bundle (no cosign where this was read): check before relying on them.
	"2.0.36": {
		AMD64: "3463ac5767445135cdaa3c5b980934e824e84216cf7190162d6bc7dbe48c6650",
		ARM64: "1b095d26356564d376097cb566dfcc19a07d7c01d9bb75a6598cd399a4c4d60e",
	},
	// 2.0.37: the two Linux lines of the v2.0.37 release's SHA256SUMS.txt, read over HTTPS from the release on 2026-11-03. NOT yet checked against the release's Sigstore bundle (no cosign where this was read): check before relying on them.
	"2.0.37": {
		AMD64: "f925394e955b36ac93009fdd6d95af52d5797915b4b764c1c05cd2d27cbbf1e0",
		ARM64: "8d7ed75267925f4606e2e9ca7e3e96c2299985b367aac2eafe0daffc5181e5ec",
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
