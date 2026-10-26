package board

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What an agent's dock lists of its board is what its read would deliver plus its own posts (#8484): ReadSetIDs and a peek take the same selection (selectRead), so for every member, role and
// receive mode, over a board long enough to need several batches, the list from the start is exactly the peek's set joined with the member's own posts (once, a post that tags its author
// included), and its pages are slices of it.
func TestTheDocksListIsWhatReadDelivers(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"Worker": {"Backend", "all"}, "Quiet": {"Frontend", "mentions"}, "Muted": {"Reviewer", "none"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "team", name, spec[0], "claude-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	post := func(who, text string) {
		_, err := s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
	}
	post("Poster", "an update that tags nobody")
	for i := 0; i < 620; i++ { // more than one batch of selected messages for Worker
		post("Poster", fmt.Sprintf("@Worker item %d", i))
		if i%97 == 0 {
			post("Poster", "@all everyone read "+fmt.Sprint(i))
			post("Poster", "the Worker queue is long, no tag")
			post("Worker", "@Worker a note to myself")
			post("Poster", "@Quiet only you "+fmt.Sprint(i))
			post("Muted", "a post by the muted member "+fmt.Sprint(i))
			post("Quiet", "@Worker a question from Quiet "+fmt.Sprint(i))
		}
	}
	_, err := s.PostSystemMessage(ctx, "team", "Coral Task Queue", "@Worker [Task #1] assigned to you", nil)
	require.NoError(t, err)

	ids := func(ms []Message) []int64 {
		out := make([]int64, len(ms))
		for i, m := range ms {
			out[i] = m.ID
		}
		return out
	}
	for _, who := range []string{"Worker", "Quiet", "Muted", "Lead", "Poster", "Nobody"} {
		t.Run(who, func(t *testing.T) {
			peek, err := s.PeekMessages(ctx, "team", who, 5000)
			require.NoError(t, err)
			// the read set joined with the member's own posts: each message once, in id order
			set := map[int64]bool{}
			for _, id := range ids(peek) {
				set[id] = true
			}
			board, err := s.ListMessages(ctx, "team", 5000, 0, 0)
			require.NoError(t, err)
			ownCount := 0
			for _, m := range board {
				if m.SubscriberID == who {
					set[m.ID] = true
					ownCount++
				}
			}
			want := make([]int64, 0, len(set))
			for id := range set {
				want = append(want, id)
			}
			sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
			if who == "Worker" || who == "Muted" {
				require.Positive(t, ownCount, "the member has posts of its own")
			}

			all, page, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 5000})
			require.NoError(t, err)
			assert.Equal(t, want, ids(all), "the list from the start is what a read would deliver plus the member's own posts, each once")
			assert.Equal(t, len(want), page.Scanned, "and its total is that set")
			assert.Zero(t, page.Remaining)
			if who == "Worker" {
				assert.Greater(t, len(want), 500, "the board is long enough to take several batches")
			}

			// pages are slices of that set: the latest few, the few before the first of them, what comes after one
			if len(want) < 12 {
				return
			}
			latest, p, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 5})
			require.NoError(t, err)
			assert.Equal(t, want[len(want)-5:], ids(latest))
			assert.Equal(t, len(want)-5, p.Remaining, "how many are older than the page")
			before, p, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 5, BeforeID: latest[0].ID})
			require.NoError(t, err)
			assert.Equal(t, want[len(want)-10:len(want)-5], ids(before))
			assert.Equal(t, len(want)-10, p.Remaining)
			after, _, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 3, AfterID: want[len(want)-10], HasAfter: true})
			require.NoError(t, err)
			assert.Equal(t, want[len(want)-9:len(want)-6], ids(after))
			none, p, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 3, AfterID: want[len(want)-1], HasAfter: true})
			require.NoError(t, err)
			assert.Empty(t, none, "nothing after the newest")
			assert.Equal(t, len(want), p.Remaining, "an empty page after the newest has every selected message before it")
		})
	}

	// listing leaves the read position alone: after a real read advanced the cursor, the list still shows the whole selection (the real read's set, and the member's own posts)
	before, err := s.ReadMessages(ctx, "team", "Quiet", 5000)
	require.NoError(t, err)
	listed, _, err := s.ListMessagesFor(ctx, "team", "Quiet", ForPage{Limit: 5000})
	require.NoError(t, err)
	listedSet := map[int64]bool{}
	for _, id := range ids(listed) {
		listedSet[id] = true
	}
	for _, id := range ids(before) {
		assert.True(t, listedSet[id], "what the real read delivered is in the list")
	}
	again, err := s.ReadMessages(ctx, "team", "Quiet", 5000)
	require.NoError(t, err)
	assert.Empty(t, again, "the read position had moved only for the read")
}

// The dock's list costs ids, not text (#8484, Security's review): a board of thousands of long messages answers a page of 50 without holding their bodies. The peak heap while it runs is
// sampled with the collector kept busy; the whole board's text is a bound it must stay well under (a list that held every selected message would pass through all of it).
func TestTheDocksListDoesNotHoldTheBoardsText(t *testing.T) {
	if testing.Short() {
		t.Skip("allocation bound")
	}
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"Worker": {"Backend", "all"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "big", name, spec[0], "claude-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	filler := strings.Repeat("a long line of the board's text, ", 120) // about 4 KB
	// the tagged rule reads one batch of text at a time (about 5.6 MB whatever the board holds): the board must hold several times that
	const n = 9000
	for i := 0; i < n; i++ {
		_, err := s.PostMessage(ctx, "big", "Poster", fmt.Sprintf("@Worker %d %s", i, filler), nil)
		require.NoError(t, err)
	}
	textBytes := uint64(n * (len(filler) + 12)) // what holding every selected message would need

	defer debug.SetGCPercent(debug.SetGCPercent(5))
	for _, who := range []string{"Worker", "Lead"} { // the member's tagged rule and the orchestrator's every-message rule
		runtime.GC()
		var base runtime.MemStats
		runtime.ReadMemStats(&base)
		var peak atomic.Uint64
		stop := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			var m runtime.MemStats
			for {
				runtime.ReadMemStats(&m)
				if m.HeapAlloc > peak.Load() {
					peak.Store(m.HeapAlloc)
				}
				select {
				case <-stop:
					return
				case <-time.After(300 * time.Microsecond):
				}
			}
		}()
		msgs, page, err := s.ListMessagesFor(ctx, "big", who, ForPage{Limit: 50})
		close(stop)
		<-done
		require.NoError(t, err)
		require.Len(t, msgs, 50)
		require.Equal(t, n, page.Scanned, who)
		grown := peak.Load() - min(peak.Load(), base.HeapAlloc)
		assert.Less(t, grown, textBytes/3, "%s: the peak heap while listing (%d bytes) stays under a third of the board's text (%d bytes)", who, grown, textBytes)
	}
}

// A search inside an agent's filtered Board tab searches only what that agent reads (#8484): for_subscriber on the search is the same list as the dock's, so a filtered search returns exactly the
// intersection of the search and the member's list, in the search's order, for every member and several words, and its pages and total agree.
func TestAFilteredSearchIsTheSearchAndTheMembersList(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"Worker": {"Backend", "all"}, "Quiet": {"Frontend", "mentions"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "team", name, spec[0], "claude-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	post := func(who, text string) {
		_, err := s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
	}
	for i := 0; i < 160; i++ {
		post("Poster", fmt.Sprintf("@Worker item %d for the review", i))
		post("Poster", fmt.Sprintf("untagged chatter %d about the review", i))
		if i%7 == 0 {
			post("Poster", fmt.Sprintf("@all standup %d, review at five", i))
			post("Worker", fmt.Sprintf("@Poster review done %d", i))
			post("Quiet", fmt.Sprintf("@Worker the review %d is Quiet's own", i))
		}
	}
	search := func(forWho, text string, limit string) (found []int64, total int) {
		cursor := ""
		for page := 0; page < 400; page++ {
			p := MessageQueryParams{Q: []string{text}, Limit: []string{limit}}
			if forWho != "" {
				p.ForSubscriber = []string{forWho}
			}
			if cursor != "" {
				p.Cursor = []string{cursor}
			}
			q, err := ParseMessageQuery(p)
			require.NoError(t, err)
			q.Project = "team"
			res, err := s.QueryMessages(ctx, q)
			require.NoError(t, err)
			for _, m := range res.Messages {
				found = append(found, m.ID)
			}
			total = res.Total
			if res.NextCursor == "" {
				return found, total
			}
			cursor = res.NextCursor
		}
		t.Fatal("a search that does not end")
		return nil, 0
	}
	for _, who := range []string{"Worker", "Quiet", "Lead", "Poster", "Nobody"} {
		list, err := s.ReadSetIDs(ctx, "team", who)
		require.NoError(t, err)
		inList := map[int64]bool{}
		for _, id := range list {
			inList[id] = true
		}
		for _, word := range []string{"review", "standup", "chatter", "Quiet's own", "nothing matches this"} {
			whole, _ := search("", word, "200") // newest first
			var want []int64
			for _, id := range whole {
				if inList[id] {
					want = append(want, id)
				}
			}
			got, total := search(who, word, "37") // pages of another size: the cursor and the filter agree
			assert.Equal(t, want, got, "%s searching %q: the search and the member's list, in the search's order", who, word)
			assert.Equal(t, len(want), total, "%s %q: and the total is theirs", who, word)
		}
	}
	// a bad name is refused as a query error, not an empty list
	for _, bad := range []string{"", "  ", strings.Repeat("x", 201), "a\x00b"} {
		_, err := ParseMessageQuery(MessageQueryParams{ForSubscriber: []string{bad}})
		require.ErrorIs(t, err, ErrMessageQuery, "%q", bad)
	}
	_, err := ParseMessageQuery(MessageQueryParams{ForSubscriber: []string{"A", "B"}})
	require.ErrorIs(t, err, ErrMessageQuery, "given twice")
}
