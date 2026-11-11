package routes

// Where a team's own files are kept (#15356). The Operator's "Add files" stores a file under the session of the team's first agent (the owner and the read check follow that session). The team's list
// finds uploads through the team's CURRENT subscribers, so an agent replaced under the same name (a new session) or any change of subscriber made the file drop off the list while it was still on disk.
// A small per-board record names every session that holds a team file, and the list reads those sessions too. Nothing is deleted by it, and an agent's removal never deletes its upload folder.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var teamHoldersMu sync.Mutex

func teamHoldersPath(coralDir, board string) string {
	if coralDir == "" || board == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(board)) // the file is named by a hash of the team's name, so no name can reach a path
	return filepath.Join(coralDir, "artifacts", "team_file_holders", hex.EncodeToString(sum[:16]))
}

// noteTeamFileHolder records that sessionID holds a file of the team's. A record that cannot be written is only logged by the caller's absence: the list then behaves as it did before.
func noteTeamFileHolder(coralDir, board, sessionID string) {
	p := teamHoldersPath(coralDir, board)
	if p == "" || uploadsDir(coralDir, sessionID) == "" {
		return
	}
	teamHoldersMu.Lock()
	defer teamHoldersMu.Unlock()
	held := readTeamFileHolders(coralDir, board)
	for _, s := range held {
		if s == sessionID {
			return
		}
	}
	if os.MkdirAll(filepath.Dir(p), 0o700) != nil {
		return
	}
	_ = writeFileAtomic(p, []byte(strings.Join(append(held, sessionID), "\n")+"\n"), 0o600)
}

// readTeamFileHolders is the sessions recorded as holding the team's files; a line that is not a safe session id is skipped.
func readTeamFileHolders(coralDir, board string) []string {
	p := teamHoldersPath(coralDir, board)
	if p == "" {
		return nil
	}
	data, err := readSmallFile(p, 64<<10)
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(data), "\n") {
		if s := strings.TrimSpace(line); s != "" && uploadsDir(coralDir, s) != "" {
			out = append(out, s)
		}
	}
	return out
}

// forgetTeamFileHolders removes a deleted team's record (#15463): a board made again under the same name starts empty, and the folder does not grow with boards that are gone. The files themselves stay in the
// store, as a deleted board's other files do.
func forgetTeamFileHolders(coralDir, board string) {
	p := teamHoldersPath(coralDir, board)
	if p == "" {
		return
	}
	teamHoldersMu.Lock()
	defer teamHoldersMu.Unlock()
	_ = os.Remove(p)
}

// removedAgentName is the name a row shows when its holding session is only on the team's record and no record of the file names who made it: the agent was removed from the team.
const removedAgentName = "removed agent"
