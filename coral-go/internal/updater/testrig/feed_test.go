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

// The check asks github.com's releases feed first, never the API, and still verifies everything: the manifest comes from the promotion release's download URL and is checked against the pinned identity.
func TestCheckFindsThePromotionInTheFeedAndNeverAsksTheAPI(t *testing.T) {
	r := newRig(t)
	rel := r.publish(Spec{Version: "1.4.131", Sequence: 7})
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	staged, err := stage.LoadStaged(r.cfg.DataDir)
	require.NoError(t, err)
	assert.Equal(t, sum(rel.Package), staged.Record.PackageSHA256)
	assert.Positive(t, r.gh.Hits[feedKey], "the feed was asked for")
	assert.Zero(t, r.gh.Hits[listKey], "and the API's list, which the anonymous rate limit counts, was not")
	assert.Positive(t, r.gh.Hits[FakeRepo+"/releases/download/"+PromotionTag("v1.4.131", 7)+"/promote.json"], "the manifest came from the promotion release's download URL")
}

// A forged promotion in the feed is refused exactly as one in the API's list: a name narrows, the signature decides.
func TestAForgedPromotionNamedInTheFeedIsRefused(t *testing.T) {
	r := newRig(t)
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
			r.gh.FeedBody = []byte(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="https://github.com/a/b/releases/tag/v1.4.100"/></entry></feed>`)
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
