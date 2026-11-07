package routes

import (
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
)

// callerSeries is the series of a digest as THIS caller may see it (#13949): an agent sees its own team's series of the bytes and never another team's (two teams that uploaded the same bytes on their own hold two files
// with two series), a Coral Hub guide the grant's board's. The owner (the dashboard, the command line, the Hub's owner) reads every team and keeps the digest's first series, as before.
func callerSeries(r *http.Request, coralDir, digest string) (sid string, n int, ok bool) {
	if g, isGuide := guideOf(r); isGuide {
		return digestSeriesOnBoard(coralDir, digest, g.Board)
	}
	if session, isAgent := agentSessionOf(r); isAgent {
		if session == "" {
			return "", 0, false
		}
		_, boardKey, err := circleOf(r.Context(), session)
		if err != nil {
			circleWarn.Do(func() { // said once, not on every read: an agent whose team cannot be placed sees no series, which would otherwise look like a file that has none (Security, #13949)
				slog.Warn("[artifacts] an agent's team could not be placed, so it sees no series of a file; later reads are not logged", "error", err)
			})
			return "", 0, false
		}
		if boardKey == "" {
			return "", 0, false
		}
		return digestSeriesOnBoard(coralDir, digest, boardKey)
	}
	return digestSeries(coralDir, digest)
}

// seriesOfDigest is every series the digest is a version of, one per team that holds it in one, sorted (the order their locks are taken in).
func seriesOfDigest(coralDir, digest string) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range recordsOfDigest(coralDir, digest) {
		if seriesIDRe.MatchString(r.rec.SeriesID) && !seen[r.rec.SeriesID] {
			seen[r.rec.SeriesID] = true
			out = append(out, r.rec.SeriesID)
		}
	}
	sort.Strings(out)
	return out
}

var circleWarn sync.Once

// teamsHolding is how many teams hold the bytes (a record of the digest on that team), the Operator's word for "this file is also in N other teams": a delete by digest removes the one object every team shares.
func teamsHolding(coralDir, digest string) int {
	seen := map[string]bool{}
	for _, r := range recordsOfDigest(coralDir, digest) {
		if r.rec.Board != "" {
			seen[r.rec.Board] = true
		}
	}
	return len(seen)
}

// alsoInTeamsNote is the words of the delete's Activity row when other teams held the bytes too, "" when none did.
func alsoInTeamsNote(teams int) string {
	if teams < 2 {
		return ""
	}
	return fmt.Sprintf("the file was also held by %d other team(s): its copy there went with it", teams-1)
}

func isGuideCaller(r *http.Request) bool { _, ok := guideOf(r); return ok }
