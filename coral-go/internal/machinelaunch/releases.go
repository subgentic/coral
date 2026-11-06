package machinelaunch

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
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
	// 2.0.39: the two Linux lines of the v2.0.39 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.39 at commit 3f814cdf9ac9a5466bb57c78959e5bcce91c41d0 (an immutable release).
	"2.0.39": {
		AMD64: "22d1ce5d62495afe76ebb3d3bf2457cb256c4693a82fc8c45455e1d19e775eb1",
		ARM64: "da943fd5b20cb3ec480cab81b12bee4b9b793bdd73659269b790281e1d94fa46",
	},
	// 2.0.41: the two Linux lines of the v2.0.41 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.41 at commit eb2856b5fb0e3c770fef4b3d5dbef13bc677fcc5 (an immutable release).
	"2.0.41": {
		AMD64: "3521579e584b49480f43fe7e9da84b463f844e59e0453cd76a34dde5624ad2d1",
		ARM64: "b1edd782c222906ce1d08ce07391a7c7dcc88fc0a6e3191236362a14ed93e6b2",
	},
	// 2.0.42: the two Linux lines of the v2.0.42 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.42 at commit 22a5bd1af45f1a6046ae2c174d612a8b389e5931 (an immutable release).
	"2.0.42": {
		AMD64: "331c4b194be5c0c2afea9f3aa0f282d999e2ff80bbe81017ba64e9fe1f81616e",
		ARM64: "f0015bec2dd4fb654daf130eaf0aa1f3ed52ef84bf60b4f2c3cf12981c78cec8",
	},
	// 2.0.43: the two Linux lines of the v2.0.43 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.43 at commit 8a2927244a54fab77733d011795bc052b127d59f (an immutable release).
	"2.0.43": {
		AMD64: "fd25bc10be54fd3cde0e25cc5295e2f71ac1234005396269df3947217d3a52af",
		ARM64: "b94dedaf985b5841d18609ec371e4febc4a823aa5eec3143526231be9dc1eef6",
	},
	// 2.0.44: the two Linux lines of the v2.0.44 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.44 at commit 4f4fe03dca120e9d561617ed3897dc992b9c3add (an immutable release).
	"2.0.44": {
		AMD64: "2b28483431880173840b0448d52a6089675bd986e5ccaac98fa0f28ecf9c5bad",
		ARM64: "715517480dece7854f39df50c211ef982b6718dcdf95cb54c1eb936afee9fdcb",
	},
	// 2.0.45: the two Linux lines of the v2.0.45 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.45 at commit 85b475d6aa57ca85feae3c84ee23c4ada4a7d947 (an immutable release).
	"2.0.45": {
		AMD64: "63cec390aca31cc4805f44429b49c37aee97ea7a9095c5a11e9819334b161afd",
		ARM64: "a4cd612b51cab19f35e80f89bd2c1c5fada2cb35a91a1be8987f69376775b042",
	},
	// 2.0.46: the two Linux lines of the v2.0.46 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.46 at commit 08cde283f9c633d737cea1cef4872d636ca2412d (an immutable release).
	"2.0.46": {
		AMD64: "b6b169c00ff781127a3694ead6173bbaf66eda04bcce8461e1b13ede36226282",
		ARM64: "063ddb43b6b52d957108d6e15faccbbf193274f91089f95d47a5e73e01f09386",
	},
	// 2.0.47: the two Linux lines of the v2.0.47 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.47 at commit 76b4e9e726988a1651202016bcbb0a9797c3c7f3 (an immutable release).
	"2.0.47": {
		AMD64: "4a075379de5a7343872163e450ecc3c3f8b9980a0ecc7fcd8a7e0808252d806e",
		ARM64: "6f376845e4d61c1ea0ba02755132609c3723b39bfdd5731ebe9c90bc8156dd05",
	},
	// 2.0.48: the two Linux lines of the v2.0.48 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.48 at commit 7c28cb97abda563560aaa166fc12be95192c2871 (an immutable release).
	"2.0.48": {
		AMD64: "62e5feef806b6f3346f9b80542235e0069a67c3677e946e6bd83b5b2a787b7ed",
		ARM64: "7b5bf5ef38f363f7e0df64f7da0ea56c31111d6cd78c0a730d7d741eb174dba1",
	},
	// 2.0.49: the two Linux lines of the v2.0.49 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.49 at commit abf4fab396d95b9377faab58cbc22841922a2a09 (an immutable release).
	"2.0.49": {
		AMD64: "2a122804d4526a5f3feac68d535c8c2f502f5cdc41dcb102e5c7a16568a66e6c",
		ARM64: "e282e6527889969d17bffcba137e48bc84d38fef0c6936f451270e9734b1abce",
	},
	// 2.0.51: the two Linux lines of the v2.0.51 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.51 at commit f69ef6fbbad97c7a9bf9e9a8afc11b1846328f82 (an immutable release).
	"2.0.51": {
		AMD64: "59973192dd5453858248c863244ade2bd0e9bf9c769b37b07dd8f53754244ef8",
		ARM64: "7fb785a010735256a623e7ea79fd9cd88617f4abff3f79bec6a0442a3816eb88",
	},
	// 2.0.52: the two Linux lines of the v2.0.52 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.52 at commit 7a7b85038f1021ddd2ac19eb287bbc173b01344c (an immutable release).
	"2.0.52": {
		AMD64: "df6b7f5baec84ddffb6170509cd4a82ed47d1e1485d3891e591017e338cf5178",
		ARM64: "ff171e8fa1784c7acdecb094a75e0112a265a860b73971de1fa53419a7379d5d",
	},
	// 2.0.53: the two Linux lines of the v2.0.53 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.53 at commit da74c9999b0bbe67b91162fbe569326471bc3935 (an immutable release).
	"2.0.53": {
		AMD64: "20aa5f97acd69f3bb30817976a86ce1170486481d7be84b15d9e3a6bdfbed7c0",
		ARM64: "b19d661838af8ebe9be04d98ebb02d47ca029668a8ca44cc26e1618de6d96e38",
	},
	// 2.0.54: the two Linux lines of the v2.0.54 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.54 at commit 515cf72c578b4867c2c16abce53ef28a52f9745e (an immutable release).
	"2.0.54": {
		AMD64: "7065fc41b5332d43a057d06ff850ce97e569a2b30e3630a459d62fe48444a5f4",
		ARM64: "ab3b358ea2186ee23fe39eb5f20c408b9d1ae2402300335f411fcb4a0260631b",
	},
	// 2.0.55: the two Linux lines of the v2.0.55 release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.55 at commit ef89652c96d806ffcec9efe2316d3e105e9a7edc (an immutable release).
	"2.0.55": {
		AMD64: "bd0aaf25884cb581aa79d12a1b78b4da9625bf70339d7647a76253096bcf5594",
		ARM64: "c316aab0a4bc42d8e63708298372dd82907e36b09daa9cf6b69c669da15a4073",
	},
}

var sha256HexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// PinnedReleaseDigests is the pinned digests for a Coral version, or false when this CLI has none for it.
func PinnedReleaseDigests(version string) (ReleaseDigests, bool) {
	d, ok := releaseDigests[version]
	return d, ok
}

// PinnedVersions is every version this CLI pins, sorted.
func PinnedVersions() []string {
	out := make([]string, 0, len(releaseDigests))
	for v := range releaseDigests {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// NoPinnedDigestWords is the refusal for a version with no pinned digest: the way out (a pinned version, or the person's own digests from a SHA256SUMS they checked) and the versions this build does pin. own says
// the version is this build's own, which the person did not ask for: a build cannot pin its own release (the digest does not exist until the release is made), so the newest CLI always meets this for itself and
// the words say so, and to pass --coral-version of a pinned one.
func NoPinnedDigestWords(version string, own bool) string {
	pinned := strings.Join(PinnedVersions(), ", ")
	if own {
		return fmt.Sprintf("Coral %s, this build's own release, is too new for this build to pin its digest (a release's digest does not exist until the release is made, so a later build pins it): pass --coral-version of a release this build pins (it pins %s), or pass --coral-sha256-amd64 and --coral-sha256-arm64, the two Linux lines of that release's SHA256SUMS.txt (check the file first)", version, pinned)
	}
	return fmt.Sprintf("this build has no pinned digest for Coral %s: pass --coral-sha256-amd64 and --coral-sha256-arm64, the two Linux lines of that release's SHA256SUMS.txt (check the file first), or launch a version this build pins (it pins %s)", version, pinned)
}

// Valid reports whether both digests are 64 lower-case hex digits.
func (d ReleaseDigests) Valid() error {
	if !sha256HexRe.MatchString(d.AMD64) || !sha256HexRe.MatchString(d.ARM64) {
		return fmt.Errorf("the Coral release digests are not two SHA-256 values (64 lower-case hex digits each)")
	}
	return nil
}
