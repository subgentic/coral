package verify

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func sumsFor(asset string, pkg []byte) []byte {
	return []byte(sha256Hex(pkg) + "  " + asset + "\n" + strings.Repeat("0", 64) + "  other.tar.gz\n")
}

func TestReleaseFilesVerifiesTheSumsTheEntryAndThePackage(t *testing.T) {
	pkg := []byte("the package bytes")
	asset := "coral-linux-amd64-2.0.10.tar.gz"
	sums := sumsFor(asset, pkg)
	signer := &fakeSigner{}
	tag := "v2.0.10"
	bundle := sign(sums, releaseIdentity(testPins, tag), testCommit)

	got, err := ReleaseFiles(signer, testPins, tag, sums, bundle, asset, bytes.NewReader(pkg), 1<<20)
	require.NoError(t, err)
	assert.Equal(t, sha256Hex(pkg), got)
	require.Len(t, signer.calls, 1)
	assert.Equal(t, releaseSAN(Repo, tag), signer.calls[0].SAN, "the signer must be the release workflow at exactly this tag")
	assert.Equal(t, RepoID, signer.calls[0].SourceRepositoryID)
}

func TestReleaseFilesRefusesEachWayItCanGoWrong(t *testing.T) {
	pkg := []byte("the package bytes")
	asset := "coral-linux-amd64-2.0.10.tar.gz"
	tag := "v2.0.10"
	sums := sumsFor(asset, pkg)
	good := sign(sums, releaseIdentity(testPins, tag), testCommit)
	stage := func(err error) string {
		var f *Failure
		if errors.As(err, &f) {
			return f.Stage
		}
		return "not a Failure: " + err.Error()
	}
	for name, c := range map[string]struct {
		tag    string
		sums   []byte
		bundle []byte
		asset  string
		pkg    []byte
		max    int64
		want   string
	}{
		"signed for another tag":     {tag, sums, sign(sums, releaseIdentity(testPins, "v2.0.9"), testCommit), asset, pkg, 1 << 20, StageSumsSignature},
		"signed by another workflow": {tag, sums, sign(sums, promoteIdentity(testPins), testCommit), asset, pkg, 1 << 20, StageSumsSignature},
		"a bundle over other sums":   {tag, sums, sign([]byte("other"), releaseIdentity(testPins, tag), testCommit), asset, pkg, 1 << 20, StageSumsSignature},
		"no bundle":                  {tag, sums, nil, asset, pkg, 1 << 20, StageSumsSignature},
		"asset not listed":           {tag, sums, good, "coral-linux-arm64-2.0.10.tar.gz", pkg, 1 << 20, StageAssetMissing},
		"package changed":            {tag, sums, good, asset, []byte("a different package"), 1 << 20, StagePackage},
		"package over the cap":       {tag, sums, good, asset, pkg, 4, StagePackage},
		"not a tag":                  {"main", sums, good, asset, pkg, 1 << 20, StageSumsFormat},
		"a tag with a path":          {"v2.0.10/../x", sums, good, asset, pkg, 1 << 20, StageSumsFormat},
		"empty sums":                 {tag, nil, good, asset, pkg, 1 << 20, StageSumsFormat},
		"malformed sums":             {tag, []byte("not sums"), sign([]byte("not sums"), releaseIdentity(testPins, tag), testCommit), asset, pkg, 1 << 20, StageSumsFormat},
	} {
		_, err := ReleaseFiles(&fakeSigner{}, testPins, c.tag, c.sums, c.bundle, c.asset, bytes.NewReader(c.pkg), c.max)
		require.Error(t, err, name)
		assert.Equal(t, c.want, stage(err), name+": "+err.Error())
	}
}
