package routes

import "net/http"

// The attention rule per person and version (#13959): what waits for the Operator, and what is read, depends on the versions they have opened (#13910), so the server's counts, the waiting and read filters and the
// Needs you answer say what the page's own rule says.

// attentionKey names a file of a team in the per-request maps.
func attentionKey(board, digest string) string { return board + "|" + digest }

// newVersionUnopened says, for the files of rows tagged for review and read, whether the person has a NEWER version to open than the one they last opened: opened_version above 0 and below the row's own version.
// Only the Operator's own attention (starVisible: never an agent's token, never a Hub caller that is not the owner) and only the rows the answer could change (for review, read, no changes requested) are looked at,
// so a list of thousands reads a handful of series. board is the team of every row, or "" when the rows carry their own (the cross-team list). The result is the request's own: nothing of it is stored in the rows,
// which are shared with other callers.
func (h *BoardHandler) newVersionUnopened(r *http.Request, board string, rows []teamArtifact) map[string]bool {
	if h.coralDir == "" || h.bs == nil || len(rows) == 0 || !starVisible(r) {
		return nil
	}
	type cand struct {
		key, series string
		n           int
		board       string
	}
	var cands []cand
	var ids []string
	seen := map[string]bool{}
	for i := range rows {
		it := &rows[i]
		if !hasTag(it.Tags, "for review") || !hasTag(it.Tags, "read") || hasTag(it.Tags, "changes requested") {
			continue
		}
		digest := artifactStoreID(*it)
		if digest == "" {
			continue
		}
		b := board
		if b == "" {
			b = it.BoardID
		}
		var sid string
		var n int
		var ok bool
		if b != "" {
			sid, n, ok = digestSeriesOnBoard(h.coralDir, digest, b)
		} else if s, tb, one := soleTeamSeries(h.coralDir, digest); one {
			b = tb
			for _, rec := range recordsOfDigest(h.coralDir, digest) {
				if rec.rec.SeriesID == s && rec.rec.Board == tb {
					sid, n, ok = s, rec.rec.Version, true
					break
				}
			}
		}
		if !ok {
			continue
		}
		cands = append(cands, cand{attentionKey(it.BoardID, digest), sid, n, b})
		if !seen[sid] {
			seen[sid] = true
			ids = append(ids, sid)
		}
	}
	if len(cands) == 0 {
		return nil
	}
	opened, err := h.bs.OpenedVersions(r.Context(), openedPersonKey(r), ids)
	if err != nil {
		return nil // what they opened cannot be read: the rule is the one without versions
	}
	out := map[string]bool{}
	for _, c := range cands {
		if v := opened[c.board+"|"+c.series]; v > 0 && v < c.n {
			out[c.key] = true
		}
	}
	return out
}
