package routes

import "net/http"

// attachOpenedVersions puts SeriesID and OpenedVersion on the rows of a page that are versions of a series, for the Operator alone and on the cross-team list alone (#13910): what they have opened is their own attention,
// never an agent's to read. The series is the one the row's own team has for its digest; the person is the verified one (openedPersonKey). A read that fails leaves the rows without the field: the row then says its
// version and not "New version".
func (h *BoardHandler) attachOpenedVersions(r *http.Request, rows []teamArtifact) {
	if h.coralDir == "" || len(rows) == 0 || h.bs == nil || !starVisible(r) {
		return
	}
	var ids []string
	seen := map[string]bool{}
	for i := range rows {
		if rows[i].Versions < 2 {
			continue
		}
		id := artifactStoreID(rows[i])
		if id == "" || rows[i].BoardID == "" {
			continue
		}
		if sid, _, ok := digestSeriesOnBoard(h.coralDir, id, rows[i].BoardID); ok {
			rows[i].SeriesID = sid
			if !seen[sid] {
				seen[sid] = true
				ids = append(ids, sid)
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	opened, err := h.bs.OpenedVersions(r.Context(), openedPersonKey(r), ids)
	if err != nil {
		return
	}
	for i := range rows {
		if v, ok := opened[rows[i].BoardID+"|"+rows[i].SeriesID]; ok && rows[i].SeriesID != "" {
			if v > rows[i].Versions {
				v = rows[i].Versions // never above the series' real newest
			}
			rows[i].OpenedVersion = v
		}
	}
}
