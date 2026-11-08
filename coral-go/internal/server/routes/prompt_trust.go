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

// trustPathMaxLines is the most lines a wrapped folder path is joined from: a longer one reads as a prefix, which is never the session's own folder, so no Yes is offered (fail closed).
const trustPathMaxLines = 8

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
	p, _ := folderTrustPathCut(screen)
	return p
}

// folderTrustPathCut is folderTrustPath that also says whether the join stopped at the trustPathMaxLines cap with more path lines below it (#14586): such a path is a prefix, never the session's own
// folder, and the row says the name is too long to read instead of 'not the folder this agent was started in'. cut is only ever true with a non-empty path.
func folderTrustPathCut(screen string) (string, bool) {
	lines := strings.Split(screen, "\n")
	at := -1
	for i, l := range lines {
		if strings.TrimSpace(l) == trustFolderHeading {
			if at >= 0 {
				return "", false
			}
			at = i
		}
	}
	if at < 0 {
		return "", false
	}
	for j := at + 1; j < len(lines) && j <= at+3; j++ {
		p := strings.TrimSpace(lines[j])
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, "Quick safety check") || strings.ContainsAny(p, "\x00\r") {
			return "", false
		}
		// A long folder wraps at the terminal's width (an agent whose terminal is narrow: one nobody has opened yet is at the launch width): the path goes on over the next lines up to the blank line
		// that ends it, at most trustPathMaxLines lines (a deep worktree under a narrow terminal wraps many times). The joined text is only ever COMPARED with the session's own recorded folder (trustOffered): a path that is not exactly that folder is never offered a Yes (#14560).
		cut := false
		for k := j + 1; k < len(lines); k++ {
			more := strings.TrimSpace(lines[k])
			if more == "" {
				break
			}
			if strings.HasPrefix(more, "Quick safety check") || strings.ContainsAny(more, "\x00\r") {
				return "", false
			}
			if k >= j+trustPathMaxLines {
				cut = true // another path line below the cap: what is joined is only the start
				break
			}
			p += more
		}
		return p, cut
	}
	return "", false
}

// markFolderTrust sets s.TrustFolder from the captured screen when s is the folder-trust menu; the offer itself is decided per caller (trustOffered).
func markFolderTrust(screen string, s *promptScreen) {
	if isFolderTrustMenu(*s) {
		s.TrustFolder, s.TrustCut = folderTrustPathCut(screen)
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
	ok, _ := h.trustVerdict(r, sessionID, s)
	return ok
}

// trustVerdict is trustOffered with the reason there is no Yes, in plain words for the row (#14572): the one check that refused it, said once. The rule is the same; only what is said about a refusal is new.
// why is "" when the offer is made, and when s is not the folder-trust menu (nothing to say).
func (h *SessionsHandler) trustVerdict(r *http.Request, sessionID string, s promptScreen) (bool, string) {
	if !isFolderTrustMenu(s) {
		return false, ""
	}
	switch {
	case !trustFolderCaller(r):
		return false, "Only the person at this computer's own dashboard can say Yes to this."
	case s.TrustFolder == "":
		return false, "Coral could not read which folder this is from the screen."
	case s.TrustCut:
		return false, "The folder name is too long to read from the screen."
	case sessionID == "" || h.ss == nil:
		return false, "Coral cannot tell which agent this is."
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil || ls == nil {
		return false, "Coral cannot find this agent's own folder to compare it with."
	}
	own := sameFolder(s.TrustFolder, ls.WorkingDir) || (ls.WorktreePath != nil && sameFolder(s.TrustFolder, *ls.WorktreePath))
	if !own {
		return false, "The folder on the screen is not the one this agent was started in."
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, "Coral could not check this folder."
	}
	if _, err = foldertrust.Check(s.TrustFolder, home, foldertrust.Ticked); err != nil {
		if why := foldertrust.PlainReason(err); why != "" {
			return false, why
		}
		return false, "Coral could not confirm this folder is safe to trust from here."
	}
	return true, ""
}

// isTrustYes is whether option opt of s is the folder-trust menu's Yes.
func isTrustYes(s promptScreen, opt promptOption) bool {
	return isFolderTrustMenu(s) && normalizeLabel(opt.Label) == normalizeLabel(trustYesLabel)
}
