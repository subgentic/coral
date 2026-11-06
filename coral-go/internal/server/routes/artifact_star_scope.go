package routes

// The star and the opened version are scoped to a team's series (#13910, Security's INFO after #13942): the same bytes uploaded by two teams are two files with two series, and an action that names only a digest must
// never reach into another team's series.

// soleTeamSeriesOf is the series of the digest when exactly ONE team holds it in a series, with that team; ok is false when no team does, and when more than one does (the digest alone is then the action's scope).
func soleTeamSeriesOf(coralDir, digest string) (string, bool) {
	sid, _, ok := soleTeamSeries(coralDir, digest)
	return sid, ok
}

func soleTeamSeries(coralDir, digest string) (seriesID, board string, ok bool) {
	for _, r := range recordsOfDigest(coralDir, digest) {
		if !seriesIDRe.MatchString(r.rec.SeriesID) || r.rec.Board == "" {
			continue
		}
		if ok && (r.rec.Board != board || r.rec.SeriesID != seriesID) {
			return "", "", false // two teams (or two series): ambiguous
		}
		seriesID, board, ok = r.rec.SeriesID, r.rec.Board, true
	}
	return seriesID, board, ok
}

// seriesMembersOfBoard is the members of the series that belong to the team that holds digest in it.
func seriesMembersOfBoard(coralDir, seriesID, digest string) []seriesMember {
	_, board, ok := soleTeamSeries(coralDir, digest)
	if !ok {
		return nil
	}
	var out []seriesMember
	for _, m := range seriesMembers(coralDir, seriesID) {
		if m.Board == board {
			out = append(out, m)
		}
	}
	return out
}
