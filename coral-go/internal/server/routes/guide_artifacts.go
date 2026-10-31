package routes

import (
	"context"
	"log/slog"
)

// What a guide reads of the artifacts (#11457). An artifact id is a content hash and a path carries no board, so Coral decides here, in the one read check every artifact route goes through (artifactReadable,
// filterReadable): a guide reads an artifact only when some record of it is an agent's upload on the grant's own board (never the Operator's own pasted or attached file, never a file received from another team), and only when the manager did not mark it private. Every other case answers as an artifact that does
// not exist (the check's 404), so a guide cannot tell a private artifact, another board's artifact and a missing one apart. An error on the way is a refusal.

// artifactStoreID is the store digest of a listed item, or "" for an item with no artifact of the store (a link the team never uploaded: nothing of the store to read).
func artifactStoreID(it teamArtifact) string {
	if it.managed != "" {
		return it.managed
	}
	if objectNameRe.MatchString(it.ID) {
		return it.ID
	}
	return ""
}

// guideMayRead says, for each id, whether a guide of board may read it. An id with no record on the board, a private one, and any id when the answer cannot be had, are false.
func guideMayRead(ctx context.Context, coralDir, boardKey string, ids []string) map[string]bool {
	out := map[string]bool{}
	if len(ids) == 0 || boardKey == "" {
		return out
	}
	var recs map[string][]artifactRecord
	var err error
	if len(ids) == 1 {
		recs, err = artifactRecordsOf(ctx, coralDir, ids[0])
	} else {
		recs, err = artifactRecordsOf(ctx, coralDir, "")
	}
	if err != nil {
		slog.Warn("[artifacts] a guide's read check could not read the records; refused", "error", err)
		return out
	}
	if artifactCircle.PrivateArtifacts == nil {
		slog.Warn("[artifacts] the private marks are not available; a guide reads nothing")
		return out
	}
	private, err := artifactCircle.PrivateArtifacts(ctx, ids)
	if err != nil {
		slog.Warn("[artifacts] a guide's read check could not read the private marks; refused", "error", err)
		return out
	}
	for _, id := range ids {
		if private[id] {
			continue
		}
		for _, rec := range recs[id] {
			if rec.agentUpload && rec.board == boardKey { // an agent's upload on this board: never the Operator's own pasted or attached file, never a file received from another team
				out[id] = true
				break
			}
		}
	}
	return out
}
