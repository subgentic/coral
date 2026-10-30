package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/verify"
)

// verify-package is how a self-hosted hub checks a release it downloaded, before it puts that release on another computer over SSH (#11370). The hub does not link the Sigstore verifier (this is
// the only program that does), so it runs this one:
//
//	coral-update verify-package --tag vX.Y.Z --asset coral-linux-<arch>-X.Y.Z.tar.gz --dir /abs/folder
//
// The folder holds exactly three plain files the hub fetched: SHA256SUMS.txt, SHA256SUMS.txt.sigstore.json and the asset. The checks are verify.ReleaseFiles': the sums against the release signer of
// exactly that tag (the compiled-in repository and id), the asset's entry, the package's hash. It reads no other file, fetches nothing but the Sigstore trusted root (as check does), and prints one
// JSON object. Exit 0 only for "verified".
const verifyPackageMax = 300 << 20

var (
	verifyAssetRe = regexp.MustCompile(`^coral-linux-(amd64|arm64)-[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[A-Za-z0-9.]{1,32})?\.tar\.gz$`)
	verifyTagRe   = regexp.MustCompile(`^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[A-Za-z0-9.]{1,32})?$`)
)

type verifyOutput struct {
	Result      string `json:"result"` // verified | failed
	SHA256      string `json:"sha256,omitempty"`
	FailedStage string `json:"failed_stage,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Trust       string `json:"trust,omitempty"`
}

// verifierFor is the Sigstore verifier with its trusted root (a variable so a test supplies its own).
var verifierFor = func(ctx context.Context) (verify.BundleVerifier, string, error) {
	trust, source, err := verify.LoadTrust(ctx, filepath.Join(config.ResolveCoralDir(""), stage.UpdatesDir, "tuf"))
	if err != nil {
		return nil, "", err
	}
	return verify.Sigstore{Trust: trust}, string(source), nil
}

func runVerifyPackage(args []string, stdout io.Writer) int {
	fail := func(stageName, reason string) int {
		print2(stdout, verifyOutput{Result: "failed", FailedStage: stageName, Reason: reason})
		return 1
	}
	var tag, asset, dir string
	for i := 0; i+1 < len(args); i += 2 {
		switch args[i] {
		case "--tag":
			tag = args[i+1]
		case "--asset":
			asset = args[i+1]
		case "--dir":
			dir = args[i+1]
		default:
			return fail("arguments", "unknown option")
		}
	}
	if len(args) != 6 || !verifyTagRe.MatchString(tag) || !verifyAssetRe.MatchString(asset) || !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
		return fail("arguments", "usage: coral-update verify-package --tag vX.Y.Z --asset coral-linux-<arch>-X.Y.Z.tar.gz --dir /absolute/folder")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	read := func(name string, max int64) ([]byte, error) {
		f, err := stage.OpenPlain(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, max+1))
		if err == nil && int64(len(b)) > max {
			err = fmt.Errorf("%s is larger than %d bytes", name, max)
		}
		return b, err
	}
	sums, err := read("SHA256SUMS.txt", verify.MaxSumsBytes)
	if err != nil {
		return fail("sums_format", "the sums file could not be read")
	}
	bundle, err := read("SHA256SUMS.txt.sigstore.json", verify.MaxBundleBytes)
	if err != nil {
		return fail("sums_signature", "the signature bundle could not be read")
	}
	pkg, err := stage.OpenPlain(filepath.Join(dir, asset))
	if err != nil {
		return fail("package", "the package could not be read")
	}
	defer pkg.Close()
	v, source, err := verifierFor(ctx)
	if err != nil {
		return fail("trusted_root", "the Sigstore trusted root could not be loaded")
	}
	sum, err := verify.ReleaseFiles(v, verify.DefaultPins(), tag, sums, bundle, asset, pkg, verifyPackageMax)
	if err != nil {
		var f *verify.Failure
		if errors.As(err, &f) {
			return fail(f.Stage, f.Reason)
		}
		return fail("package", "the package could not be verified")
	}
	print2(stdout, verifyOutput{Result: "verified", SHA256: sum, Trust: source})
	return 0
}

func print2(w io.Writer, o verifyOutput) { _ = json.NewEncoder(w).Encode(o) }
