package license

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/subgentic/coral/internal/testguard"
	terms "github.com/subgentic/coral/pkg/license"
)

// The acceptance a self-hosted hub records on a computer it sets Coral up on over SSH (#11370). The hub's owner saw the terms in the setup dialog and pressed Set up; the hub then runs
// `coral accept-terms` on the far computer with the acceptance on STDIN (never in argv, where any process of that computer could read it). A normal install never gets this: nothing in Coral's
// start, update or dashboard calls it, and a person at a terminal is still asked.
//
// The marker says who and when, besides the version and the digest of the text:
//
//	accepted
//	version=2026-03-26
//	sha256=c1997b07…
//	source=hub-owner
//	accepted_by=hub-owner@build-host
//	accepted_at=<RFC3339, this computer's clock when it was written>
//
// The source is fixed here; a request cannot name it. The funnel (#10004) has no word for it, so AcceptedSource reports it as none and nothing is sent for it.

// ErrTermsMismatch is an acceptance of other terms than this binary's: another version or another text.
var ErrTermsMismatch = errors.New("license: these are not the terms this Coral has")

var hubOwnerByRe = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)

// RecordHubOwnerAcceptance records the acceptance of this binary's terms for the hub owner `by`. It refuses unless version equals EULAVersion and digest equals the text's SHA-256, so an
// acceptance of one text can never stand for another; `by` is a short label, not free text.
func RecordHubOwnerAcceptance(version, digest, by string) error {
	if version != EULAVersion || digest != terms.EULADigest() {
		return ErrTermsMismatch
	}
	if !hubOwnerByRe.MatchString(by) {
		return errors.New("license: the accepting owner's label is not valid")
	}
	marker := EULAMarkerPath()
	if marker == "" {
		return errors.New("license: no place to record the acceptance")
	}
	testguard.CheckDataPath(marker)
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf("accepted\nversion=%s\nsha256=%s\nsource=hub-owner\naccepted_by=%s\naccepted_at=%s\n", EULAVersion, digest, by, eulaNow().UTC().Format(time.RFC3339))
	return os.WriteFile(marker, []byte(content), 0o644) // no funnel note: this is not one of the funnel's sources
}
