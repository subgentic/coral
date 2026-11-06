package routes

import (
	"net/http"
	"sort"

	"github.com/subgentic/coral/internal/cloud"
)

// The star follows the series (#13910): the Operator who pins a document is coordinating across its versions, so a star on any version stars the series, a new version is starred at once, and an unstar of any
// version clears them all. Nothing new is stored: the stars stay a digest and a time, and the series is worked out at read time from the upload records, the authority (digestSeries, seriesMembers).

// starInfo is what the star state says of one digest.
type starInfo struct {
	At      string   // when the series was last starred (RFC 3339): the newest star of any of its versions
	Series  string   // the series' id, "" for a file in none
	Latest  bool     // this digest is its series' newest version (true for a file in no series)
	Earlier []string // on the newest version: the older versions' digests, oldest first (at most maxEarlierDigests), so a decision on the one row shown can settle them (#13910)
}

// starFollow works out, from the starred digests and their times, what each ROW counts as starred, keyed "board|digest": a row is a digest on one team, and a team's series is its own (#13910, Security's INFO after #13942:
// two teams that hold the same bytes hold two files, and a star on one team's version must not follow into another team's series). A starred digest is starred on every team that has a record of it, and the series it
// is a version of ON THAT TEAM follows there and nowhere else: every version of that team's series counts as starred (the row says so) and only the newest is Latest, so a pinned list can show the series once.
// "|digest" is the digest's own star with no team (a row with no record of its own, a per-team list that names no board).
func starFollow(coralDir string, stars map[string]string) map[string]starInfo {
	out := map[string]starInfo{}
	type teamSeries struct{ board, id string }
	bySeries := map[teamSeries]string{} // a team's series -> newest star time
	for d, at := range stars {
		out["|"+d] = starInfo{At: at, Latest: true}
		for _, r := range recordsOfDigest(coralDir, d) {
			if r.rec.Board == "" {
				continue
			}
			key := r.rec.Board + "|" + d
			if _, set := out[key]; !set {
				out[key] = starInfo{At: at, Latest: true}
			}
			if seriesIDRe.MatchString(r.rec.SeriesID) {
				ts := teamSeries{r.rec.Board, r.rec.SeriesID}
				if at > bySeries[ts] {
					bySeries[ts] = at
				}
			}
		}
	}
	for ts, at := range bySeries {
		var members []seriesMember
		for _, m := range seriesMembers(coralDir, ts.id) {
			if m.Board == ts.board { // a series is one team's; a member of another team is never followed into
				members = append(members, m)
			}
		}
		newest, best := "", -1
		for _, m := range members {
			if m.N > best {
				best, newest = m.N, m.Digest
			}
		}
		var earlier []string
		for _, m := range sortedByVersion(members) {
			if m.Digest != newest && len(earlier) < maxEarlierDigests {
				earlier = append(earlier, m.Digest)
			}
		}
		for _, m := range members {
			info := starInfo{At: at, Series: ts.id, Latest: m.Digest == newest}
			if info.Latest {
				info.Earlier = earlier
			}
			out[ts.board+"|"+m.Digest] = info
		}
	}
	return out
}

// starOf is the star state of a row of the given team (board "" when the list names none): the team's own entry, else the digest's star on its own.
func starOf(m map[string]starInfo, board, digest string) (starInfo, bool) {
	if digest == "" {
		return starInfo{}, false
	}
	if info, ok := m[board+"|"+digest]; ok {
		return info, true
	}
	info, ok := m["|"+digest]
	return info, ok
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

// maxEarlierDigests bounds the older versions a pinned row carries.
const maxEarlierDigests = 50

// sortedByVersion is the members oldest first.
func sortedByVersion(ms []seriesMember) []seriesMember {
	out := append([]seriesMember(nil), ms...)
	sort.Slice(out, func(i, j int) bool { return out[i].N < out[j].N })
	return out
}
