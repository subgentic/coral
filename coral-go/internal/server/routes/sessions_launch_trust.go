package routes

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/foldertrust"
)

// Launching a team in a folder counts as trusting it for the agents that ask (#11889, the Operator's decision), under Security's conditions: only the person's own dashboard asks (never an agent, the Hub or the
// CLI); only a folder this launch made, or an existing one the person ticked by name; never home, a parent of it, a hidden folder under it or a direct child of it unless Coral made it (foldertrust.Check); and the reply
// names what was trusted and what was not, so the page and the Operator can see it. The writes are foldertrust's: one entry each, never over a link, never an entry the person turned down.

// trustFolderCaller reports whether the request is the person's own dashboard, the only caller whose launch may trust a folder in this version.
func trustFolderCaller(r *http.Request) bool {
	if agentCaller(r) || cloud.Tunneled(r) {
		return false
	}
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	return kind == callerDashCookie || kind == callerDashNoCookie
}

// trustCardless names the agent types whose CLI asks about a folder but has no setting Coral can set (nothing documented for Antigravity): their card stays.
var trustCardless = map[string]string{
	"agy": "no setting Coral can set: its card stays", "antigravity": "no setting Coral can set: its card stays", "gemini": "no setting Coral can set: its card stays",
}

// claudeConfigPath is Claude's settings file: $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json.
func claudeConfigPath(home string) string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, ".claude.json")
	}
	return filepath.Join(home, ".claude.json")
}

// codexConfigPath is Codex's config: $CODEX_HOME/config.toml, else ~/.codex/config.toml.
func codexConfigPath(home string) string {
	if d := os.Getenv("CODEX_HOME"); d != "" {
		return filepath.Join(d, "config.toml")
	}
	return filepath.Join(home, ".codex", "config.toml")
}

// trustTeamFolder trusts the folder the team starts in for its members' CLIs, when the launch asks for it (the folder was made by this launch, or the person ticked it), and answers what the launch reply says: the
// path, the agent types trusted and, for each that was not, why; or why nothing was. nil when nothing was asked. workdir is where the agents start (a worktree's folder when the team uses one); madeDir says the launch
// made the chosen folder, which counts only when the agents start in it and not in a worktree of existing code.
func (h *SessionsHandler) trustTeamFolder(r *http.Request, body launchTeamRequest, workdir string, madeDir, worktree bool) map[string]any {
	basis := foldertrust.Existing
	switch {
	case madeDir && !worktree:
		basis = foldertrust.Made
	case body.TrustFolder:
		basis = foldertrust.Ticked
	default:
		return nil // nothing was asked
	}
	reply := map[string]any{"path": workdir, "trusted": []string{}}
	if !trustFolderCaller(r) {
		reply["refused"] = "only the person's own dashboard trusts a folder for a team"
		return reply
	}
	home, err := os.UserHomeDir()
	if err != nil {
		reply["refused"] = "the home folder is not known"
		return reply
	}
	resolved, err := foldertrust.Check(workdir, home, basis)
	if err != nil {
		reply["refused"] = err.Error()
		h.sayTrustNotDone(r, body, workdir, "", err.Error()) // asked for and not done: the board says why (#12338)
		return reply
	}
	reply["path"] = resolved
	types, _ := teamMemberTypes(body)
	seen := map[string]bool{}
	trusted := []string{}
	not := map[string]string{}
	failed := map[string]string{} // the agent types Coral tried to trust the folder for and could not: said on the board
	for _, typ := range types {
		if typ == "" {
			typ = "claude"
		}
		if seen[typ] {
			continue
		}
		seen[typ] = true
		var werr error
		switch typ {
		case "claude":
			_, werr = foldertrust.TrustClaude(claudeConfigPath(home), resolved)
		case "codex":
			_, werr = foldertrust.TrustCodex(codexConfigPath(home), resolved)
		default:
			if why, ok := trustCardless[typ]; ok {
				not[typ] = why
			}
			continue // the others show no folder-trust card
		}
		if werr != nil {
			not[typ] = werr.Error()
			failed[typ] = werr.Error()
			continue
		}
		trusted = append(trusted, typ)
	}
	sort.Strings(trusted)
	reply["trusted"] = trusted
	if len(trusted) > 0 && body.BoardName != "" && h.bs != nil { // an Operator can see it afterwards: one message on the team's board
		bh := h.boardHandler
		if bh == nil {
			bh = NewBoardHandler(h.bs) // postNotice and noticeText need only the store
		}
		ctx := r.Context()
		// The folder's name is text from the disk: cleaned and made unable to mention anyone (noticeText), then quoted, and posted by postNotice as it stands (the census of stored text, #9231).
		bh.postNotice(ctx, body.BoardName, fmt.Sprintf("[Coral] Coral trusted the folder %s for %s, so its settings and tools run with no question. Turn it off in the agent's own settings if you did not mean it.", quoteNotice(bh.noticeText(ctx, body.BoardName, resolved)), strings.Join(trusted, ", ")))
	}

	if len(failed) > 0 {
		types := make([]string, 0, len(failed))
		for typ := range failed {
			types = append(types, typ)
		}
		sort.Strings(types)
		reasons := make([]string, 0, len(types))
		for _, typ := range types {
			reasons = append(reasons, typ+": "+failed[typ])
		}
		h.sayTrustNotDone(r, body, workdir, strings.Join(types, ", "), strings.Join(reasons, "; "))
	}
	if len(failed) > 0 {
		reply["failed"] = failed // the types it tried and could not, apart from "not" (which also holds the types that have no setting to set): the page says these
	}
	if len(not) > 0 {
		reply["not"] = not
	}
	return reply
}

// sayTrustNotDone posts one line on the team's board when trusting the folder was asked for (the tick, or a folder the launch made) and Coral did not: without it the agents stop at their CLIs' trust cards and nobody
// is told why (#12338: a folder in /tmp, a shared place, was refused by design and nothing said so). The folder and the reason are text that came from outside the notice's own words, so they are cleaned, made unable to
// mention anyone and quoted (noticeText, quoteNotice), and the line is posted as it stands (postNotice, the census of stored text). Nothing is posted for a caller that is not the person's own dashboard.
func (h *SessionsHandler) sayTrustNotDone(r *http.Request, body launchTeamRequest, workdir, forTypes, reason string) {
	if body.BoardName == "" || h.bs == nil {
		return
	}
	bh := h.boardHandler
	if bh == nil {
		bh = NewBoardHandler(h.bs)
	}
	ctx := r.Context()
	who := ""
	if forTypes != "" {
		who = " for " + forTypes
	}
	bh.postNotice(ctx, body.BoardName, fmt.Sprintf("[Coral] Coral did not trust the folder %s%s: %s. The agents will ask about it in their own terminals; answer there, or choose a folder Coral can trust.",
		quoteNotice(bh.noticeText(ctx, body.BoardName, workdir)), who, quoteNotice(bh.noticeText(ctx, body.BoardName, reason))))
}
