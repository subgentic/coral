package routes

import (
	"net/http"
	"sort"
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
		if err != nil || boardKey == "" {
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
