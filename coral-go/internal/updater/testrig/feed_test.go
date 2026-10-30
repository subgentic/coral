package testrig

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/stage"
)

const feedKey = FakeRepo + "/releases.atom"

// newAPIRig is a rig whose check asks the API's list of releases and not the Atom feed: the tests of the list's own ways to be wrong (a server error, an oversize body, a list that is not a list, a rate limit)
// are about that path, which the feed leaves as the fallback (#9712).
func newAPIRig(t *testing.T) *rig {
	t.Helper()
	r := newRig(t)
	r.cfg.FeedURL = ""
	return r
}

// The check asks github.com's releases feed first, never the API for a feed that shows nothing newer. A newer product release in it is what makes the API's list worth asking (the real feed names no promotion).
func TestANewerReleaseInTheFeedMakesTheCheckAskTheAPIList(t *testing.T) {
	r := newRig(t)
	rel := r.publish(Spec{Version: "1.4.131", Sequence: 7})
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	staged, err := stage.LoadStaged(r.cfg.DataDir)
	require.NoError(t, err)
	assert.Equal(t, sum(rel.Package), staged.Record.PackageSHA256)
	assert.Equal(t, 1, r.gh.Hits[feedKey], "the feed was asked for first")
	assert.Positive(t, r.gh.Hits[listKey], "a release newer than the installed one is in it: the API's list finds its promotion")
	assert.Positive(t, r.gh.Hits[FakeRepo+"/releases/download/"+PromotionTag("v1.4.131", 7)+"/promote.json"], "the manifest came from the promotion release's download URL")
}

// A feed that names product releases and none newer than the installed one ends the check with no API request and no download (#9716): up to date, nothing recorded but the check's time.
func TestAFeedWithNothingNewerEndsTheCheckWithNoAPIRequest(t *testing.T) {
	for name, setup := range map[string]func(r *rig){
		"the installed version is the newest": func(r *rig) { r.publish(Spec{Version: installed, Sequence: 7}) },
		"older releases only": func(r *rig) {
			r.publish(Spec{Version: "1.4.100", Sequence: 7})
			r.publish(Spec{Version: "1.4.129", Sequence: 8})
		},
		"a newer prerelease is not a newer release": func(r *rig) {
			r.publish(Spec{Version: installed, Sequence: 7})
			r.gh.FeedExtra = []string{"v1.4.131-rc1", "v1.4.140-beta2"}
		},
		"the installed version is ahead of the feed": func(r *rig) { r.publish(Spec{Version: "1.4.100", Sequence: 7}); r.cfg.Installed = "1.4.200" },
		"a reordered feed: the newest by version, not by position": func(r *rig) {
			r.publish(Spec{Version: installed, Sequence: 7})
			r.publish(Spec{Version: "1.4.50", Sequence: 8})
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			setup(r)
			res := r.check()
			assert.Equal(t, stage.ResultUpToDate, res.Result, "%+v", res)
			assert.Equal(t, 1, r.gh.Hits[feedKey])
			assert.Zero(t, r.gh.Hits[listKey], "no API request")
			for k, n := range r.gh.Hits {
				assert.False(t, n > 0 && strings.Contains(k, "promote"), "no promotion was downloaded: %s", k)
			}
			r.nothingStaged()
		})
	}
}

// A feed that cannot say is not "up to date": no product tag in it (empty, prereleases only, odd tags, an error page that happens to parse), an installed version that cannot be compared, or a newer one anywhere in it
// (whatever its position) all ask the API's list as always. Only a feed with at least one well-formed product tag and none newer may stop the check.
func TestAFeedThatCannotSayAsksTheAPIList(t *testing.T) {
	for name, setup := range map[string]func(r *rig){
		"no entries": func(r *rig) {
			r.gh.FeedBody = []byte(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`)
		},
		"prereleases only": func(r *rig) { r.gh.FeedBody = feedOf("v1.4.131-rc1", "v1.4.130-beta") },
		"odd tags only": func(r *rig) {
			r.gh.FeedBody = feedOf("nightly", "1.4.100", "v1.4", "v1.4.100.1", "vv1.4.100", "v1.4.100-")
		},
		"a parseable error page": func(r *rig) {
			r.gh.FeedBody = []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><body>Service Unavailable</body></html>`)
		},
		"an old tag first and a newer one last": func(r *rig) { r.gh.FeedBody = feedOf("v1.4.100", "v1.4.120", "v1.4.131") },
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			r.publish(Spec{Version: "1.4.131", Sequence: 7})
			setup(r)
			res := r.check()
			assert.Positive(t, r.gh.Hits[listKey], "the API's list was asked; the result was %+v", res)
		})
	}
}

// The shortcut decides only whether to ask: a later release that appears is found by the next check (a stale or forged feed can only delay it, nothing is recorded as "up to date for a while"). The rollback
// copy's own lookup is for an exact tag (onlyTag) and never takes the shortcut (promote.go).
func TestAReleaseThatAppearsAfterTheShortcutIsFoundByTheNextCheck(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: installed, Sequence: 7})
	res := r.check()
	require.Equal(t, stage.ResultUpToDate, res.Result, "%+v", res)
	assert.Zero(t, r.gh.Hits[listKey])
	// a later release appears: the next check finds it
	r.publish(Spec{Version: "1.4.131", Sequence: 8})
	res = r.check()
	assert.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
}

// feedOf is a feed that names these tags, newest first.
func feedOf(tags ...string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">`)
	for _, t := range tags {
		b.WriteString(`<entry><link rel="alternate" type="text/html" href="https://github.com/a/b/releases/tag/` + t + `"/></entry>`)
	}
	b.WriteString(`</feed>`)
	return []byte(b.String())
}

// A forged promotion in the feed is refused exactly as one in the API's list: a name narrows, the signature decides.
func TestAForgedPromotionNamedInTheFeedIsRefused(t *testing.T) {
	r := newRig(t)
	r.gh.FeedWithPromotions = true // the real feed names none; a feed that did must not be trusted
	rel := r.publish(Spec{Version: "1.4.131", Sequence: 5})
	// a newer promotion release anyone with write access could name: its manifest has no valid signature
	r.gh.PublishPromotion(PromotionTag("v1.4.140", 99), rel.Manifest, []byte("not a bundle"))
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "the real promotion still wins: %+v", res)
	staged, err := stage.LoadStaged(r.cfg.DataDir)
	require.NoError(t, err)
	assert.Equal(t, "1.4.131", staged.Record.Version, "the forged 1.4.140 was not taken")
	// and with only the forged one named, the check refuses
	r2 := newRig(t)
	r2.gh.FeedWithPromotions = true
	rel2, err := r2.s.NewRelease(Spec{Version: "1.4.131", Sequence: 5})
	require.NoError(t, err)
	r2.gh.PublishPromotion(PromotionTag("v1.4.131", 50), rel2.Manifest, []byte("not a bundle"))
	res2 := r2.check()
	assert.Equal(t, stage.ResultFailed, res2.Result, "%+v", res2)
	r2.nothingStaged()
}

// The feed cannot answer: the API's list is the fallback. A server error, a body that is not XML, a document with a DTD, a feed that names no promotion at all.
func TestTheAPIListIsTheFallbackWhenTheFeedCannotAnswer(t *testing.T) {
	huge := append([]byte(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">`), []byte(strings.Repeat(" ", stage.MaxFeedBytes+10))...)
	for name, setup := range map[string]func(r *rig){
		"a server error":                       func(r *rig) { r.gh.Status["feed"] = 503 },
		"not found":                            func(r *rig) { r.gh.Status["feed"] = 404 },
		"a forbidden that is not a rate limit": func(r *rig) { r.gh.Status["feed"] = 403 },
		"not XML":                              func(r *rig) { r.gh.FeedBody = []byte("<html>not a feed") },
		"empty":                                func(r *rig) { r.gh.FeedBody = []byte{} },
		"a document with a DTD": func(r *rig) {
			r.gh.FeedBody = []byte(`<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "y">]><feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="https://github.com/a/b/releases/tag/` + PromotionTag("v1.4.131", 7) + `"/></entry></feed>`)
		},
		"larger than the limit": func(r *rig) { r.gh.FeedBody = huge },
		"a feed with no entries": func(r *rig) {
			r.gh.FeedBody = []byte(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`)
		},
		"no promotion among its tags": func(r *rig) {
			r.gh.FeedBody = feedOf("v1.4.131", "v1.4.100")
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			r.publish(Spec{Version: "1.4.131", Sequence: 7})
			setup(r)
			res := r.check()
			require.Equal(t, stage.ResultStaged, res.Result, "found through the API's list: %+v", res)
			assert.Positive(t, r.gh.Hits[feedKey], "the feed was tried first")
			assert.Positive(t, r.gh.Hits[listKey], "and the API's list answered")
		})
	}
}

// A rate limit from the feed is waited out like one from the API: no fallback to the API (a second quota to spend), no new request before the reset.
func TestARateLimitFromTheFeedIsWaitedOutAndNotWorkedAround(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	r.gh.Status["feed"] = 429
	r.gh.Headers = map[string]map[string]string{"feed": {"Retry-After": "600"}}
	res := r.check()
	require.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
	assert.Equal(t, "manifest", res.FailedStage)
	assert.Zero(t, r.gh.Hits[listKey], "the API was not asked instead")
	assert.Equal(t, stage.ResultBackoff, r.check().Result, "and nothing is asked before the wait is over")
	assert.Equal(t, 1, r.gh.Hits[feedKey])
}

// Feed parsing: the tags, newest first, once each; entries without an alternate link to a release page and tags with a slash are skipped; a hostile document is refused.
func TestFeedTagsReadsOnlyTheReleaseTags(t *testing.T) {
	good := `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes</title>
  <entry><link rel="alternate" type="text/html" href="https://github.com/a/b/releases/tag/promote-v2.0.1-3"/><title>x</title></entry>
  <entry><link rel="self" href="https://github.com/a/b/releases/tag/ignored-self"/></entry>
  <entry><link rel="alternate" href="https://github.com/a/b/releases/tag/promote-v2.0.1-3"/></entry>
  <entry><link rel="alternate" href="https://github.com/a/b/releases/tag/v2.0.1"/></entry>
  <entry><link rel="alternate" href="https://github.com/a/b/releases/tag/a%2Fb"/></entry>
  <entry><link rel="alternate" href="https://github.com/a/b/releases"/></entry>
  <entry><title>no link</title></entry>
</feed>`
	tags, err := stage.FeedTags([]byte(good))
	require.NoError(t, err)
	assert.Equal(t, []string{"promote-v2.0.1-3", "v2.0.1"}, tags)

	for name, body := range map[string]string{
		"empty":             "",
		"not XML":           "<html><body>no",
		"truncated":         `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="x`,
		"a DOCTYPE":         `<!DOCTYPE feed><feed xmlns="http://www.w3.org/2005/Atom"/>`,
		"an entity bomb":    `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><feed xmlns="http://www.w3.org/2005/Atom"><title>&lol2;</title></feed>`,
		"an unknown entity": `<feed xmlns="http://www.w3.org/2005/Atom"><title>&nope;</title></feed>`,
	} {
		_, err := stage.FeedTags([]byte(body))
		assert.Error(t, err, name)
	}
	// a feed with no entries is a feed with no tags
	tags, err = stage.FeedTags([]byte(`<feed xmlns="http://www.w3.org/2005/Atom"></feed>`))
	require.NoError(t, err)
	assert.Empty(t, tags)
	// more than thirty entries: the first thirty are read
	var b strings.Builder
	b.WriteString(`<feed xmlns="http://www.w3.org/2005/Atom">`)
	for i := 0; i < 40; i++ {
		b.WriteString(`<entry><link rel="alternate" href="https://github.com/a/b/releases/tag/v1.0.` + strings.Repeat("1", 1) + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `"/></entry>`)
	}
	b.WriteString(`</feed>`)
	tags, err = stage.FeedTags([]byte(b.String()))
	require.NoError(t, err)
	assert.Len(t, tags, 30)
}

// An installed version that is no Coral version (a dev build) is refused by the check before any request, so the feed is never asked and nothing is concluded from it. (A
// prerelease of a release, 1.4.130-rc1, is a Coral version: it is compared, and offered 1.4.131.)
func TestANonSemverInstalledVersionNeverReachesTheFeed(t *testing.T) {
	for _, v := range []string{"dev", "v1.4.130", "1.4.130+x", ""} {
		r := newRig(t)
		r.publish(Spec{Version: "1.4.131", Sequence: 7})
		r.cfg.Installed = v
		res := r.check()
		assert.Equal(t, stage.ResultFailed, res.Result, "installed %q: %+v", v, res)
		assert.Equal(t, "installed_version", res.FailedStage)
		assert.Zero(t, r.gh.Hits[feedKey], "no feed request")
		assert.Zero(t, r.gh.Hits[listKey], "no API request")
	}
}
