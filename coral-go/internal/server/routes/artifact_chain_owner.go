package routes

import "strings"

// chainFileIsTheUploaders says whether the chain's file (the last file an agent uploaded for the line) was uploaded by this agent (#13908): from the upload record of that file, the authority, never from a flag. A plain
// upload joins an open file of its line only when it is its own agent's: another agent's follow-up starts a series of its own, and says --new-version-of when it means another's. When a PERSON saved a newer version after
// the agent's file, the file is still the agent's and the join is still attempted, so the stale refusal tells the agent (#13792, the Operator: refuse at once, whoever made the newer version).
func chainFileIsTheUploaders(coralDir, board, hex, uploader string) bool {
	if coralDir == "" || strings.TrimSpace(uploader) == "" {
		return false
	}
	for _, r := range recordsOfDigest(coralDir, hex) {
		if r.rec.Board == board && isAgentUploadRecord(r.rec) && strings.EqualFold(strings.TrimSpace(r.rec.Uploader), strings.TrimSpace(uploader)) {
			return true
		}
	}
	return false
}
