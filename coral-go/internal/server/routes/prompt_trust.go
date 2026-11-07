package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/foldertrust"
	"github.com/subgentic/coral/internal/safefs"
)

// The one named exception to "a Needs you row never grants more than this one time" (#10400): Claude's folder-trust menu (#14110, Security's conditions).
// A row may answer "Yes, I trust this folder" only when ALL of this holds, read by the server from the terminal right now, never from the agent's words or
// a client's:
//   - the parsed menu is exactly Claude's two options, in these labels and this order, under this question;
//   - the screen names the folder on the line after "Accessing workspace:" and foldertrust.Check accepts it (not home, a parent of home, a root, a hidden
//     folder under home, not an existing folder);
//   - the caller is the person's own dashboard (trustFolderCaller), never the Hub, a viewer, a guide or an agent.
//
// Any other menu, even one with the word "trust" in it, keeps the one-time rule. The answer is the chat's own route (answer-prompt); a row sends the folder it
// drew and the server refuses the Yes when the screen now names another folder.
const (
	trustQuestionStart = "Quick safety check: Is this a project you created or one you trust?"
	trustNoLabel       = "No, exit"
	trustYesLabel      = "Yes, I trust this folder"
	trustFolderHeading = "Accessing workspace:"
)

// isFolderTrustMenu says whether s is Claude's folder-trust menu, by structure and not by the word trust.
func isFolderTrustMenu(s promptScreen) bool {
	return s.Unnumbered && !s.Multi && len(s.Options) == 2 &&
		normalizeLabel(s.Options[0].Label) == normalizeLabel(trustNoLabel) &&
		normalizeLabel(s.Options[1].Label) == normalizeLabel(trustYesLabel) &&
		strings.HasPrefix(strings.TrimSpace(s.Question), trustQuestionStart)
}

// folderTrustPath is the folder the screen names under "Accessing workspace:" (the next non-blank line, one line), "" when there is no such single line, or when the
// captured screen holds MORE than one such heading: text printed before the menu (a startup hook, a program, a spoofed copy of the heading) must not choose the folder that is shown
// and checked (Security's MUST on #14110). The caller then also pins the path to the session's own recorded folder (trustOffered).
func folderTrustPath(screen string) string {
	lines := strings.Split(screen, "\n")
	at := -1
	for i, l := range lines {
		if strings.TrimSpace(l) == trustFolderHeading {
			if at >= 0 {
				return ""
			}
			at = i
		}
	}
	if at < 0 {
		return ""
	}
	for j := at + 1; j < len(lines) && j <= at+3; j++ {
		p := strings.TrimSpace(lines[j])
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, "Quick safety check") || strings.ContainsAny(p, "\x00\r") {
			return ""
		}
		return p
	}
	return ""
}

// markFolderTrust sets s.TrustFolder from the captured screen when s is the folder-trust menu; the offer itself is decided per caller (trustOffered).
func markFolderTrust(screen string, s *promptScreen) {
	if isFolderTrustMenu(*s) {
		s.TrustFolder = folderTrustPath(screen)
	}
}

// sameFolder says whether two folders are the same after cleaning and link resolution; an empty or unresolvable one is never the same.
func sameFolder(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ra, err := safefs.Resolve(filepath.Clean(a))
	if err != nil {
		return false
	}
	rb, err := safefs.Resolve(filepath.Clean(b))
	if err != nil {
		return false
	}
	return ra == rb
}

// trustOffered says whether the row may offer Yes for s to this caller: the menu is the folder-trust menu, its folder was read and is one Coral may trust, the folder is the live session's
// OWN recorded working directory or its worktree folder (what Coral knows, not what the terminal printed: Security's MUST on #14110), and the caller is the person's own dashboard.
func (h *SessionsHandler) trustOffered(r *http.Request, sessionID string, s promptScreen) bool {
	if s.TrustFolder == "" || !isFolderTrustMenu(s) || !trustFolderCaller(r) || sessionID == "" || h.ss == nil {
		return false
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil || ls == nil {
		return false
	}
	own := sameFolder(s.TrustFolder, ls.WorkingDir) || (ls.WorktreePath != nil && sameFolder(s.TrustFolder, *ls.WorktreePath))
	if !own {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	_, err = foldertrust.Check(s.TrustFolder, home, foldertrust.Ticked)
	return err == nil
}

// isTrustYes is whether option opt of s is the folder-trust menu's Yes.
func isTrustYes(s promptScreen, opt promptOption) bool {
	return isFolderTrustMenu(s) && normalizeLabel(opt.Label) == normalizeLabel(trustYesLabel)
}
