package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/updatecheck"
)

// #9726: where the updater checks for this install, GET /api/system/update-check answers from the updater's own record of its last check and asks GitHub for nothing; anywhere else, or when the record cannot
// be trusted (stale, not in shape, for an install the updater does not check), the notice asks GitHub as it always did.
func updaterNoticeRig(t *testing.T, rec UpdaterRecord, recErr error) (url string, githubHits *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.4.150", "draft": false, "prerelease": false, "html_url": "https://github.com/subgentic/coral/releases/tag/v1.4.150"})
	}))
	t.Cleanup(gh.Close)
	orig := githubReleasesAPI
	githubReleasesAPI = uniqueFeedURL(gh.URL)
	t.Cleanup(func() { githubReleasesAPI = orig })
	origV := config.Version
	config.Version = "1.4.130"
	t.Cleanup(func() { config.Version = origV })
	origTier := config.TierChecksForUpdates
	config.TierChecksForUpdates = true // a dev build does not check for updates: the route would answer "not available" before reading anything
	t.Cleanup(func() { config.TierChecksForUpdates = origTier })

	server, handler := setupSystemTestServer(t)
	handler.SetUpdaterRecord(func(ctx context.Context) (UpdaterRecord, error) { return rec, recErr })
	return server.URL, &hits
}

func freshRecord(result, newest string) UpdaterRecord {
	return UpdaterRecord{Enabled: true, Supported: true, CheckedAt: time.Now().Add(-time.Hour), CheckResult: result, Newest: newest}
}

func getUpdateCheck(t *testing.T, url string) map[string]any {
	t.Helper()
	resp, err := http.Get(url + "/api/system/update-check")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	return body
}

func TestTheNoticeIsAnsweredFromTheUpdatersRecordWithNoRequestToGitHub(t *testing.T) {
	for name, tc := range map[string]struct {
		rec       UpdaterRecord
		available bool
		latest    string
	}{
		"a newer release the last check saw":     {freshRecord("not_promoted", "1.4.140"), true, "1.4.140"},
		"up to date":                             {freshRecord("up_to_date", "1.4.130"), false, "1.4.130"},
		"up to date, nothing newer seen":         {freshRecord("up_to_date", ""), false, ""},
		"the newest seen is older than this one": {freshRecord("up_to_date", "1.4.100"), false, "1.4.100"},
		"a rate limit with a newer release":      {freshRecord("rate_limited", "1.4.140"), true, "1.4.140"},
		"a failed check keeps what it saw":       {freshRecord("failed", "1.4.140"), true, "1.4.140"},
		"a staged release is the newest": {func() UpdaterRecord {
			r := freshRecord("staged", "1.4.140")
			r.Staged = &StagedUpdate{Version: "1.4.141", Verified: true}
			return r
		}(), true, "1.4.141"},
	} {
		t.Run(name, func(t *testing.T) {
			url, hits := updaterNoticeRig(t, tc.rec, nil)
			body := getUpdateCheck(t, url)
			assert.Equal(t, tc.available, body["available"], "%v", body)
			assert.Equal(t, tc.latest, body["latest"])
			assert.Equal(t, "1.4.130", body["current"])
			assert.Equal(t, updatecheck.ReleasePageURL(updatecheck.Approved, tc.latest), body["release_url"], "the link is built from the pinned repository, never from the record")
			assert.Equal(t, true, body["approved"])
			assert.Zero(t, hits.Load(), "GitHub was not asked")
		})
	}
}

func TestARecordThatCannotBeTrustedLeavesTheNoticeAskingGitHub(t *testing.T) {
	stale := freshRecord("up_to_date", "1.4.130")
	stale.CheckedAt = time.Now().Add(-updateRecordFresh - time.Minute)
	future := freshRecord("up_to_date", "1.4.130")
	future.CheckedAt = time.Now().Add(time.Hour)
	never := freshRecord("up_to_date", "1.4.130")
	never.CheckedAt = time.Time{}
	off := freshRecord("up_to_date", "1.4.130")
	off.Enabled = false
	unsupported := freshRecord("up_to_date", "1.4.130")
	unsupported.Supported = false
	for name, tc := range map[string]struct {
		rec UpdaterRecord
		err error
	}{
		"older than twice the check's interval": {stale, nil},
		"dated in the future":                   {future, nil},
		"never checked":                         {never, nil},
		"the updater is off":                    {off, nil},
		"an install the updater cannot update":  {unsupported, nil},
		"a result that is not in the set":       {freshRecord("<script>", "1.4.130"), nil},
		"unknown":                               {freshRecord("unknown", "1.4.130"), nil},
		"no result":                             {freshRecord("", "1.4.130"), nil},
		"the record cannot be read":             {UpdaterRecord{}, errors.New("the updater did not answer")},
	} {
		t.Run(name, func(t *testing.T) {
			url, hits := updaterNoticeRig(t, tc.rec, tc.err)
			body := getUpdateCheck(t, url)
			assert.Equal(t, true, body["available"], "answered by GitHub's 1.4.150: %v", body)
			assert.Equal(t, "1.4.150", body["latest"])
			assert.Positive(t, hits.Load(), "GitHub was asked")
		})
	}
	t.Run("a stale record is fresh again once the updater checks", func(t *testing.T) {
		url, hits := updaterNoticeRig(t, freshRecord("up_to_date", "1.4.130"), nil)
		assert.Equal(t, false, getUpdateCheck(t, url)["available"])
		assert.Zero(t, hits.Load())
	})
}

// A version in the record that is not X.Y.Z is never sent (the record validates it, and the route does again), and the agentic channel's notice keeps its own feed.
func TestTheNoticeSendsOnlyAValidatedVersionAndTheAgenticChannelKeepsItsFeed(t *testing.T) {
	url, hits := updaterNoticeRig(t, freshRecord("not_promoted", "1.4.140<script>"), nil)
	body := getUpdateCheck(t, url)
	assert.Equal(t, "", body["latest"])
	assert.Equal(t, false, body["available"])
	assert.Zero(t, hits.Load())

	rec := freshRecord("up_to_date", "1.4.130")
	var h atomic.Int64
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Add(1); w.WriteHeader(http.StatusInternalServerError) }))
	t.Cleanup(gh.Close)
	origA := githubReleasesListAPI
	githubReleasesListAPI = uniqueFeedURL(gh.URL)
	t.Cleanup(func() { githubReleasesListAPI = origA })
	server, handler := setupSystemTestServer(t)
	handler.SetUpdaterRecord(func(ctx context.Context) (UpdaterRecord, error) { return rec, nil })
	require.NoError(t, handler.ss.SetSetting(context.Background(), "update_channel", "agentic"))
	resp, err := http.Get(server.URL + "/api/system/update-check")
	require.NoError(t, err)
	resp.Body.Close()
	assert.Positive(t, h.Load(), "the agentic channel asks its own feed, whatever the updater recorded")
}
