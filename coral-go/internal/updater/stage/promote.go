package stage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/updater/verify"
)

// A promotion is its own release (#6393). Immutable releases refuse a new asset on a published release, so the promote workflow publishes promote.json and its bundle as a release of
// their own, named promote-<product tag>-<sequence> (a prerelease, never Latest), and a second promotion (a revocation) is a new such release, never a replacement. The client finds the
// manifest of the newest promotion by listing the newest releases, never by trusting a name or an order: a candidate counts only if the promote workflow signed it.
const (
	// ReleasesList is the newest releases of the repository, newest first (one page).
	ReleasesList = "https://api.github.com/repos/" + verify.Repo + "/releases?per_page=30"

	// maxListBytes caps the list's size: 30 releases are well under it, and a larger answer is refused, not truncated.
	maxListBytes = 1 << 20
	// maxPromoteCandidates is how many promotion releases one pass looks at, newest first: junk by anyone with write access costs this many small downloads, no more.
	maxPromoteCandidates = 10
)

// promoteTagRe is a promotion release's tag: promote-<product tag>-<sequence>. The name only narrows what is looked at; the signature and the manifest's own tag and sequence decide.
var promoteTagRe = regexp.MustCompile(`^promote-(v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4})-([0-9]{1,12})$`)

type listedRelease struct {
	TagName string `json:"tag_name"`
	Draft   bool   `json:"draft"`
	Assets  []struct {
		Name string `json:"name"`
	} `json:"assets"`
	fromFeed bool // named by the releases feed, which lists no assets: the download says whether they are there
}

func (r listedRelease) hasPromotionAssets() bool {
	if r.fromFeed {
		return true
	}
	var m, b bool
	for _, a := range r.Assets {
		switch a.Name {
		case ManifestFile:
			m = true
		case ManifestBundleFile:
			b = true
		}
	}
	return m && b
}

// promotion is a verified candidate: a manifest the promote workflow signed, for the product tag its release names.
type promotion struct {
	tag      string
	manifest []byte
	bundle   []byte
	m        *verify.Manifest
}

// errNoPromotion says there is no promotion release listed (for the tag asked for): nothing was promoted.
var errNoPromotion = errors.New("no promotion")

// noneVerified is what a pass returns when there were candidates and none verified: the newest candidate's refusal, which is what the check records (Settings shows it) and backs off on, the
// same back-off as any verification failure (an hour, doubling to a day), so junk costs one small pass an hour at most.
type noneVerified struct {
	version string // the newest candidate's version, from its name
	failure *verify.Failure
	junk    int
}

func (e *noneVerified) Error() string {
	return fmt.Sprintf("%d promotion release(s) listed and none verified (newest: %s)", e.junk, e.failure.Error())
}

// findPromotion lists the newest releases and returns the highest-sequence promotion that verifies, for any product tag, or, when onlyTag is not "", for that tag. A candidate is a non-draft
// release named promote-<tag>-<n> carrying both assets, at most maxPromoteCandidates of them; it is skipped (and counted) unless its manifest verifies against the pinned promote identity,
// names the tag and the sequence its release names. It returns errNoPromotion when none is listed, and a *noneVerified when there were candidates and none verified.
func (c *checker) findPromotion(ctx context.Context, onlyTag string) (p *promotion, junk int, err error) {
	list, err := c.releaseList(ctx, onlyTag)
	if err != nil {
		return nil, 0, err
	}
	c.noteNewest(list)
	looked := 0
	var rehearsal *promotion
	var first *noneVerified
	skip := func(version string, f *verify.Failure) {
		junk++
		if first == nil {
			first = &noneVerified{version: version, failure: f}
		}
	}
	for _, r := range list {
		sm := promoteTagRe.FindStringSubmatch(r.TagName)
		if sm == nil || r.Draft || !r.hasPromotionAssets() {
			continue
		}
		if onlyTag != "" && sm[1] != onlyTag {
			continue
		}
		if looked++; looked > maxPromoteCandidates {
			break
		}
		seq, _ := strconv.ParseInt(sm[2], 10, 64)
		version := strings.TrimPrefix(sm[1], "v")
		base := c.cfg.DownloadBase + r.TagName + "/"
		manifest, merr := c.cfg.Fetcher.Get(ctx, base+ManifestFile, verify.MaxManifestBytes)
		var bundle []byte
		var berr error
		if merr == nil {
			bundle, berr = c.cfg.Fetcher.Get(ctx, base+ManifestBundleFile, verify.MaxBundleBytes)
		}
		if merr != nil || berr != nil {
			// A file the list says the release has and that answers 404 is not junk: it is a promotion published seconds ago that the download host doesn't serve yet. Skipping it
			// would let an older promotion win this pass, so a revocation could lose to the promotion it revokes; it stops the pass like any other fetch error, and the network
			// back-off tries again (Security's #337).
			if errors.Is(merr, verify.ErrTooLarge) || errors.Is(berr, verify.ErrTooLarge) {
				skip(version, &verify.Failure{Stage: verify.StageManifestDocument, Reason: "a file of the promotion release is larger than the limit"}) // junk, not an outage: it must not hide the releases behind it
				continue
			}
			if merr != nil {
				return nil, junk, fmt.Errorf("%s of %s: %w", ManifestFile, r.TagName, merr)
			}
			return nil, junk, fmt.Errorf("%s of %s: %w", ManifestBundleFile, r.TagName, berr)
		}
		m, verr := verify.PromotionManifest(c.cfg.Verifier, c.cfg.Pins, manifest, bundle)
		if verr != nil {
			var f *verify.Failure
			if !errors.As(verr, &f) {
				f = &verify.Failure{Stage: verify.StageManifestDocument, Reason: verr.Error()}
			}
			skip(version, f)
			continue
		}
		if m.Tag != sm[1] || m.Sequence != seq {
			skip(version, &verify.Failure{Stage: verify.StageManifestRules, Reason: "the manifest names another tag or sequence than its release"})
			continue
		}
		if m.Prerelease {
			// A rehearsal's manifest is signed and valid but is never what a Coral updates to: it is skipped before the highest sequence is picked, so a rehearsal with a higher
			// sequence than the real promotion of the same tag cannot hide the real one (Security's #6393 follow-up). When there is no other candidate the highest one is kept, so the
			// rules refuse it by its flag as before and the check says why nothing was staged.
			if rehearsal == nil || m.Sequence > rehearsal.m.Sequence {
				rehearsal = &promotion{tag: r.TagName, manifest: manifest, bundle: bundle, m: m}
			}
			continue
		}
		if p == nil || m.Sequence > p.m.Sequence {
			p = &promotion{tag: r.TagName, manifest: manifest, bundle: bundle, m: m}
		}
	}
	if p == nil && rehearsal != nil {
		p = rehearsal
	}
	if p == nil {
		if first != nil {
			first.junk = junk
			return nil, junk, first
		}
		return nil, junk, errNoPromotion
	}
	if junk > 0 {
		log.Printf("[update] %d promotion release(s) listed did not verify and were skipped", junk)
	}
	return p, junk, nil
}

// errFeedNothingNewer says the releases feed names product releases and none is newer than the installed version: there is nothing to look for, and the API's list is not asked (#9716).
var errFeedNothingNewer = errors.New("the releases feed names no release newer than the installed one")

// productTagRe is a product release's tag, vX.Y.Z (the shape of promoteTagRe's tag): a prerelease (-rc, -beta) or anything else is not one, because the updater never offers a prerelease (a rehearsal's
// manifest is skipped, findPromotion), so one in the feed is not "a newer release".
var productTagRe = regexp.MustCompile(`^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$`)

// feedNothingNewer is true when the feed names at least one product release and none is newer than installed. A feed with no product tag cannot say, and an installed version that is not X.Y.Z (a prerelease build)
// cannot be compared: both are "unknown", and the API's list is asked as it always was. The feed only decides whether to ask; what is installed still comes from a verified manifest.
func feedNothingNewer(list []listedRelease, installed string) bool {
	saw := false
	for _, r := range list {
		if !productTagRe.MatchString(r.TagName) {
			continue
		}
		saw = true
		cmp, err := verify.CompareVersions(strings.TrimPrefix(r.TagName, "v"), installed)
		if err != nil || cmp > 0 {
			return false
		}
	}
	return saw
}

// releaseList is the newest releases: from the releases feed (no API request, #9704), and from the API's list when the feed cannot say (it did not answer, is not a feed, or names no promotion). A
// rate-limit answer from the feed is not worked around: the check waits for it like for the API's (the caller reads the *verify.StatusError).
func (c *checker) releaseList(ctx context.Context, onlyTag string) ([]listedRelease, error) {
	if c.cfg.FeedURL != "" {
		list, err := c.listFromFeed(ctx)
		var se *verify.StatusError
		switch {
		case errors.As(err, &se) && se.RateLimited:
			return nil, err
		case err != nil:
			log.Printf("[update] the releases feed could not be used (%v): asking the API's list", err)
		default:
			c.noteNewest(list)
			if onlyTag == "" && feedNothingNewer(list, c.cfg.Installed) {
				return nil, errFeedNothingNewer // most checks end here: no API request at all
			}
			for _, r := range list {
				if promoteTagRe.MatchString(r.TagName) {
					return list, nil
				}
			}
			// no promotion among the feed's newest releases: the API's list goes further back (30)
		}
	}
	raw, err := c.cfg.Fetcher.Get(ctx, c.cfg.ReleasesURL, maxListBytes)
	if err != nil {
		return nil, err
	}
	var list []listedRelease
	if json.Unmarshal(raw, &list) != nil {
		return nil, errors.New("the list of releases is not a list")
	}
	if len(list) > 100 {
		list = list[:100] // a page is 30: anything more is not read
	}
	return list, nil
}

// noteNewest remembers the highest product release (X.Y.Z, a vX.Y.Z tag that is not a prerelease) among the listed ones: the check records it (recordOutcome).
func (c *checker) noteNewest(list []listedRelease) {
	for _, r := range list {
		if r.Draft || !productTagRe.MatchString(r.TagName) {
			continue
		}
		v := strings.TrimPrefix(r.TagName, "v")
		if cmp, err := verify.CompareVersions(v, c.newest); c.newest == "" || (err == nil && cmp > 0) {
			c.newest = v
		}
	}
}
