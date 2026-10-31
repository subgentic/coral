package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/verify"
)

// stubVerifier accepts a bundle that says the identity it is asked for, so the test does not need a real Sigstore signature.
type stubVerifier struct{ want *verify.Identity }

func (s *stubVerifier) VerifyBundle(bundle, artifact []byte, id verify.Identity) (verify.Cert, error) {
	s.want = &id
	if string(bundle) != "good-bundle" {
		return verify.Cert{}, errors.New("bad bundle")
	}
	return verify.Cert{SAN: id.SAN}, nil
}

func packageDir(t *testing.T, pkg []byte, asset string) string {
	t.Helper()
	dir := t.TempDir()
	sum := sha256.Sum256(pkg)
	sums := hex.EncodeToString(sum[:]) + "  " + asset + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "SHA256SUMS.txt"), []byte(sums), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "SHA256SUMS.txt.sigstore.json"), []byte("good-bundle"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, asset), pkg, 0o600))
	return dir
}

func runVerify(t *testing.T, args ...string) (int, verifyOutput, *stubVerifier) {
	t.Helper()
	sv := &stubVerifier{}
	old := verifierFor
	verifierFor = func(context.Context) (verify.BundleVerifier, string, error) { return sv, "embedded", nil }
	defer func() { verifierFor = old }()
	var out bytes.Buffer
	code := run(append([]string{"verify-package"}, args...), func(string) string { return "" }, &out)
	var o verifyOutput
	require.NoError(t, json.Unmarshal(out.Bytes(), &o), out.String())
	return code, o, sv
}

func TestVerifyPackageAcceptsAGoodReleaseAndNamesTheTagSigner(t *testing.T) {
	asset := "coral-linux-amd64-2.0.10.tar.gz"
	pkg := []byte("package")
	dir := packageDir(t, pkg, asset)
	code, o, sv := runVerify(t, "--tag", "v2.0.10", "--asset", asset, "--dir", dir)
	require.Equal(t, 0, code, "%+v", o)
	sum := sha256.Sum256(pkg)
	assert.Equal(t, "verified", o.Result)
	assert.Equal(t, hex.EncodeToString(sum[:]), o.SHA256)
	require.NotNil(t, sv.want)
	assert.Equal(t, "https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.10", sv.want.SAN)
	assert.Equal(t, verify.RepoID, sv.want.SourceRepositoryID)
}

func TestVerifyPackageRefusesWhatItShould(t *testing.T) {
	asset := "coral-linux-amd64-2.0.10.tar.gz"
	good := packageDir(t, []byte("package"), asset)
	tampered := packageDir(t, []byte("package"), asset)
	require.NoError(t, os.WriteFile(filepath.Join(tampered, asset), []byte("tampered"), 0o600))
	badBundle := packageDir(t, []byte("package"), asset)
	require.NoError(t, os.WriteFile(filepath.Join(badBundle, "SHA256SUMS.txt.sigstore.json"), []byte("forged"), 0o600))
	linked := packageDir(t, []byte("package"), asset)
	require.NoError(t, os.Remove(filepath.Join(linked, asset)))
	require.NoError(t, os.Symlink(filepath.Join(good, asset), filepath.Join(linked, asset)))
	empty := t.TempDir()

	for name, c := range map[string]struct {
		args  []string
		stage string
	}{
		"tampered package":  {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", tampered}, verify.StagePackage},
		"forged bundle":     {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", badBundle}, verify.StageSumsSignature},
		"a symlink package": {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", linked}, "package"},
		"no files":          {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", empty}, "sums_format"},
		"a tag that is not": {[]string{"--tag", "main", "--asset", asset, "--dir", good}, "arguments"},
		"a path in asset":   {[]string{"--tag", "v2.0.10", "--asset", "../" + asset, "--dir", good}, "arguments"},
		"another platform":  {[]string{"--tag", "v2.0.10", "--asset", "Coral.v2.0.10.dmg", "--dir", good}, "arguments"},
		"a relative dir":    {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", "rel"}, "arguments"},
		"an unclean dir":    {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", good + "/../x"}, "arguments"},
		"an extra option":   {[]string{"--tag", "v2.0.10", "--asset", asset, "--dir", good, "--url", "x"}, "arguments"},
		"an unknown option": {[]string{"--tag", "v2.0.10", "--asset", asset, "--bogus", good}, "arguments"},
	} {
		code, o, _ := runVerify(t, c.args...)
		assert.Equal(t, 1, code, name)
		assert.Equal(t, "failed", o.Result, name)
		assert.Equal(t, c.stage, o.FailedStage, name+": "+o.Reason)
	}
}

func TestVerifyPackageFailsWhenTheTrustedRootCannotLoad(t *testing.T) {
	asset := "coral-linux-amd64-2.0.10.tar.gz"
	dir := packageDir(t, []byte("package"), asset)
	old := verifierFor
	verifierFor = func(context.Context) (verify.BundleVerifier, string, error) { return nil, "", errors.New("offline") }
	defer func() { verifierFor = old }()
	var out bytes.Buffer
	code := run([]string{"verify-package", "--tag", "v2.0.10", "--asset", asset, "--dir", dir}, func(string) string { return "" }, &out)
	assert.Equal(t, 1, code)
	assert.Contains(t, out.String(), "trusted_root")
	assert.NotContains(t, out.String(), "offline", "the cause is not echoed")
}
