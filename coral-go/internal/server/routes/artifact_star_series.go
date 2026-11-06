package routes

import (
	"net/http"

	"github.com/subgentic/coral/internal/cloud"
)

// The star follows the series (#13910): the Operator who pins a document is coordinating across its versions, so a star on any version stars the series, a new version is starred at once, and an unstar of any
// version clears them all. Nothing new is stored: the stars stay a digest and a time, and the series is worked out at read time from the upload records, the authority (digestSeries, seriesMembers).

// starInfo is what the star state says of one digest.
type starInfo struct {
	At     string // when the series was last starred (RFC 3339): the newest star of any of its versions
	Series string // the series' id, "" for a file in none
	Latest bool   // this digest is its series' newest version (true for a file in no series)
}

// starFollow works out, from the starred digests and their times, every digest that counts as starred and what it says: each starred digest itself, and every version of its series. A digest that is a version of a
// starred series but not its newest is starred too (the row says so) and is not Latest, so a pinned list can show the series once.
func starFollow(coralDir string, stars map[string]string) map[string]starInfo {
	out := map[string]starInfo{}
	bySeries := map[string]string{} // series -> newest star time
	for d, at := range stars {
		if sid, _, ok := digestSeries(coralDir, d); ok {
			if at > bySeries[sid] {
				bySeries[sid] = at
			}
			continue
		}
		out[d] = starInfo{At: at, Latest: true}
	}
	for sid, at := range bySeries {
		members := seriesMembers(coralDir, sid)
		newest, best := "", -1
		for _, m := range members {
			if m.N > best {
				best, newest = m.N, m.Digest
			}
		}
		for _, m := range members {
			out[m.Digest] = starInfo{At: at, Series: sid, Latest: m.Digest == newest}
		}
	}
	// a starred digest whose series has no readable members (an index lost, a record gone) still counts as starred itself
	for d, at := range stars {
		if _, ok := out[d]; !ok {
			out[d] = starInfo{At: at, Latest: true}
		}
	}
	return out
}

// starVisible says whether this caller may see the Operator's bookmarks: not an agent's token (the per-board list is an agent's to read), and through Coral Hub only the owner. The star state is the Operator's own
// attention (what they pinned), never a team's.
func starVisible(r *http.Request) bool {
	if callerActor(r).Kind == ActorToken {
		return false
	}
	if cloud.Tunneled(r) {
		return hubOwnerRequest(r).owner
	}
	return true
}
