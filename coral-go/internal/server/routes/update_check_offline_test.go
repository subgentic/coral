package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updatecheck"
)

// #9360: with the outside network black-holed (a feed that never answers) a page's update check does not hold its connection for the whole request: it
// answers within updateCheckWait, the request goes on in the background, and the next ask gets the answer. A person's "Check for Updates" waits for it.
func TestUpdateCheckDoesNotWaitForABlackHoledNetwork(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release: // the network comes back
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.9.9", "draft": false, "prerelease": false, "html_url": "https://github.com/subgentic/coral/releases/tag/v9.9.9"})
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) }) // runs before server.Close: nothing is left waiting on it
	feeds := updatecheck.Feeds{Approved: uniqueFeedURL(server.URL), Agentic: uniqueFeedURL(server.URL)}

	start := time.Now()
	feed, err := feedWithin(context.Background(), updatecheck.Approved, feeds, false, 250*time.Millisecond)
	took := time.Since(start)
	assert.Nil(t, feed)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Less(t, took, 2*time.Second, "the page's check gave up long before the 5 s request would have")
	assert.GreaterOrEqual(t, took, 200*time.Millisecond)

	// the request the cache started was not cancelled: once the network is back the next ask has the feed
	release <- struct{}{}
	require.Eventually(t, func() bool {
		f, err := feedWithin(context.Background(), updatecheck.Approved, feeds, false, 250*time.Millisecond)
		return err == nil && f != nil && f.Offer.Version == "9.9.9"
	}, 5*time.Second, 50*time.Millisecond)
}

// #9467 (the #9360 review's LOW): a person's "Check for Updates" (refresh) waits for the whole request. Past updateCheckWait the page's own check gives up, but refresh must not:
// with the feed still not answering it is still waiting, and it returns the feed once the answer comes.
func TestRefreshWaitsForTheWholeRequestWhereThePagesCheckGivesUp(t *testing.T) {
	release := make(chan struct{})
	var asked atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v8.8.8", "draft": false, "prerelease": false, "html_url": "https://github.com/subgentic/coral/releases/tag/v8.8.8"})
	}))
	t.Cleanup(server.Close)
	released := false
	releaseOnce := func() {
		if !released {
			released = true
			close(release)
		}
	}
	t.Cleanup(releaseOnce)
	feeds := updatecheck.Feeds{Approved: uniqueFeedURL(server.URL), Agentic: uniqueFeedURL(server.URL)}

	const wait = 150 * time.Millisecond
	type result struct {
		feed *updatecheck.Feed
		err  error
	}
	done := make(chan result, 1)
	start := time.Now()
	go func() {
		f, err := feedWithin(context.Background(), updatecheck.Approved, feeds, true, wait)
		done <- result{f, err}
	}()
	select {
	case r := <-done:
		t.Fatalf("a refresh came back after %v, before the feed answered (feed %v, err %v): it must wait for the whole request", time.Since(start).Round(time.Millisecond), r.feed, r.err)
	case <-time.After(4 * wait): // well past the page's own give-up
	}
	require.EqualValues(t, 1, asked.Load(), "the request is the one in flight, not a new one")

	releaseOnce() // the network answers
	select {
	case r := <-done:
		require.NoError(t, r.err)
		require.NotNil(t, r.feed)
		assert.Equal(t, "8.8.8", r.feed.Offer.Version, "the refresh answered with the feed it waited for")
	case <-time.After(5 * time.Second):
		t.Fatal("the refresh never returned after the feed answered")
	}
}
