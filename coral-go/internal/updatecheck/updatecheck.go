// Package updatecheck is the one update check the server and the tray share (#3660, update
// audit items 4 and 5). It asks GitHub for the latest release and offers it only when it is
// strictly newer than this build:
//   - only an HTTP 200 reply counts (a rate-limit 403 is an error, not "no update");
//   - the body is read up to MaxBody;
//   - tag_name must look like a version (v1.2.3 or v1.2.3-rc1) before it reaches a toast, a
//     dismissed key or an OS notification; anything else is an error;
//   - versions compare as semver, so a newer, dev or beta build is never told to move to an
//     older release.
//
// Coral never downloads or runs an update: the caller shows the releases page.
package updatecheck

import (
	"context"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/semverorder"
	"net/http"
	"time"
)

const (
	// ReleasesAPI is GitHub's latest-release endpoint for Coral (prereleases excluded), asked by the repository's numeric id like the Agentic list: a repository
	// re-created under the same name has another id and is not followed (#5557).
	ReleasesAPI = "https://api.github.com/repositories/1160696364/releases/latest"
	// ReleasesURL is the page the update notice links to.
	ReleasesURL = "https://github.com/subgentic/coral/releases"
	// MaxBody caps the reply read: a release object is a few KB.
	MaxBody = 64 << 10
	// Timeout bounds the whole request.
	Timeout = 5 * time.Second
)

// client asks the release feed. A redirect (GitHub answers one for a renamed repository) is followed only on the same host and never from https
// to http, so a feed that answers "go there" cannot send the check to another server or onto a plain connection (#5025). It is its own client:
// the check does not depend on http.DefaultClient, which any code in the process can change.
var client = &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("updatecheck: too many redirects")
	}
	first := via[0].URL
	if req.URL.Host != first.Host || req.URL.Scheme != first.Scheme {
		return fmt.Errorf("updatecheck: the release feed redirected to another host or scheme (%s)", req.URL.Redacted())
	}
	return nil
}}

// tagShape is a release tag: v, three numbers, an optional prerelease of letters, digits and dots.
var tagShape = semverorder.TagShape

// ErrBadTag is a reply whose tag_name doesn't look like a version.
var ErrBadTag = errors.New("updatecheck: the release tag is not a version")

// Latest returns the latest release's version (without the "v"), from apiURL (ReleasesAPI;
// tests pass their own). It is the Approved channel's feed read through FetchFeed, so it makes the same checks as the
// channel reads (an OK status, a version-shaped tag, not a draft or pre-release, and the reply's page URL being this
// repository's tag page, #5568). The request is anonymous: it reads a public endpoint, and no credential
// from the environment (GITHUB_TOKEN, which is often a developer's token with write rights) is
// attached to it (#4133).
func Latest(ctx context.Context, apiURL string) (string, error) {
	f, err := FetchFeed(ctx, Approved, apiURL, time.Now())
	if err != nil {
		return "", err
	}
	return f.Offer.Version, nil
}

// Newer reports whether latest is strictly newer than current, both versions with or without a
// "v". A current that isn't a version ("dev", "") is never offered an update.
func Newer(latest, current string) bool {
	return semverorder.Newer(latest, current)
}

// NotNewer reports whether candidate is a version that is NOT newer than current: older or equal, both parsing as versions (a prerelease of a version is older than the version, as in Newer).
// A version that doesn't parse says nothing here (false), so a build whose version is "dev" or unknown never has an update dropped by this.
func NotNewer(candidate, current string) bool {
	return semverorder.NotNewer(candidate, current)
}

// Available is Latest, then Newer against current: the version to offer, or "".
func Available(ctx context.Context, apiURL, current string) (string, error) {
	latest, err := Latest(ctx, apiURL)
	if err != nil || !Newer(latest, current) {
		return "", err
	}
	return latest, nil
}

type version = semverorder.Version

func parse(s string) (version, bool) { return semverorder.Parse(s) }

func compare(a, b version) int { return semverorder.Compare(a, b) }
