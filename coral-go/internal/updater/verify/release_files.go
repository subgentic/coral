package verify

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"regexp"
)

// tagRe is a release tag as release.yml is run for: v, three numbers, and an optional suffix (-dev, -beta, -rc1, -forDropbox).
var tagRe = regexp.MustCompile(`^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[A-Za-z0-9.]{1,32})?$`)

// ReleaseFiles verifies a release package that was downloaded WITHOUT the updater's promote manifest (#11370: the self-hosted hub installs the release it runs itself onto another computer, over SSH):
// the release's SHA256SUMS.txt against its Sigstore bundle for the release signer of exactly this tag (the same pinned identity and repository id as the updater, never a pattern), the sums file's
// entry for asset, and the package's own hash against it. It returns the package's SHA-256 (lower-case hex) for the later re-check on the far computer.
//
// It has no promote manifest, so none of the updater's rollout rules apply (no "newer than installed", no revocation): the caller names the version, and it is the release the hub itself runs.
func ReleaseFiles(v BundleVerifier, pins Pins, tag string, sums, sumsBundle []byte, asset string, pkg io.Reader, maxPackage int64) (string, error) {
	if !tagRe.MatchString(tag) {
		return "", fail(StageSumsFormat, "%q is not a release tag", tag)
	}
	if len(sums) == 0 || len(sums) > MaxSumsBytes {
		return "", fail(StageSumsFormat, "sums size %d is outside 1..%d", len(sums), MaxSumsBytes)
	}
	if _, err := v.VerifyBundle(sumsBundle, sums, releaseIdentity(pins, tag)); err != nil {
		return "", fail(StageSumsSignature, "%v", err)
	}
	entries, err := ParseSums(sums)
	if err != nil {
		return "", fail(StageSumsFormat, "%v", err)
	}
	want, ok := entries[asset]
	if !ok {
		return "", fail(StageAssetMissing, "%s is not in the signed sums file", asset)
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(pkg, maxPackage+1))
	if err != nil {
		return "", fail(StagePackage, "reading the package: %v", err)
	}
	if n > maxPackage {
		return "", fail(StagePackage, "the package is larger than %d bytes", maxPackage)
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != want {
		return "", fail(StagePackage, "%s is %s, the verified sums file says %s", asset, got, want)
	}
	return got, nil
}
