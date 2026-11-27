package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/board"
)

// adoptReceivedFile makes a file that came to the team from a linked team (a "received" row on its board, with the cross-team message it came with) one of the team's own files, so it can be sent for review
// (#21811): before, "coral-agent artifact review" said "this team has no such file", because a received row names a send and never an upload. The bytes are not copied: the object is shared by digest;
// what is added is an upload record by this agent's session on this team's board, saying where it came from (ReceivedFrom). Only a row on THIS team's own board counts: the rule that no agent reads another
// team's files is unchanged, and a file the team was never sent is still refused.
func adoptReceivedFile(coralDir, teamBoard, sessionID, id string) bool {
	if coralDir == "" || teamBoard == "" || !objectNameRe.MatchString(id) {
		return false
	}
	sum := sha256.Sum256([]byte(teamBoard))
	rowPath := filepath.Join(coralDir, "artifacts", "received", hex.EncodeToString(sum[:16]), id+".json")
	data, err := readSmallFile(rowPath, 64<<10)
	if err != nil {
		return false
	}
	var row crossTeamArtifactRecord
	if json.Unmarshal(data, &row) != nil || row.Board != teamBoard || row.ID != id { // the row is on this team's board and names this file
		return false
	}
	meta, ok := readSidecar(filepath.Join(coralDir, "artifacts", "objects", id+".json"))
	if !ok { // the bytes are not in the store (removed, or never stored): nothing to review
		return false
	}
	up := uploadsDir(coralDir, sessionID)
	if up == "" {
		return false
	}
	if _, have := readUploadRecord(coralDir, sessionID, id); have {
		return true
	}
	if err := os.MkdirAll(up, 0o700); err != nil {
		return false
	}
	rec := newUploadRecord(meta, sessionID, "", "")
	if rec.Board != teamBoard { // the session is not on this team's board: it is not this team's to adopt for
		return false
	}
	if board.ValidLabel(row.OtherBoard, uploaderLabelMax) {
		rec.ReceivedFrom = row.OtherBoard
	}
	rec.DocID = row.DocID
	out, err := json.Marshal(rec)
	if err != nil {
		return false
	}
	if err := writeFileAtomic(filepath.Join(up, id+".json"), out, 0o600); err != nil {
		return false
	}
	noteArtifactRecordChanged(coralDir, teamBoard)
	return true
}
