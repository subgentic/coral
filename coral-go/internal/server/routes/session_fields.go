package routes

import (
	"encoding/json"
	"github.com/subgentic/coral/internal/gitguard"
	"slices"

	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// Session-list fields that /api/sessions/live and /ws/coral both send. Both
// builders call these, so a client (dashboard or Cloud Hub) gets identical
// values from either source.

// lookupGitState finds an agent's latest git snapshot: by session first, then
// by agent name (agents launched before snapshots carried a session id).
func lookupGitState(states map[string]*store.GitSnapshot, sessionID, agentName string) *store.GitSnapshot {
	var git *store.GitSnapshot
	if sessionID != "" {
		git = states[sessionID]
	}
	if git == nil {
		git = states[agentName]
	}
	return git
}

// gitListFields returns the branch, repo_name and git_state entry values.
// git_state is set only for worktrees, branches with a known base, or a folder whose live git updates are paused (git_state.paused: the counts are the last read).
func gitListFields(git *store.GitSnapshot) (branch, repoName, gitState any) {
	if git == nil {
		return nil, nil, nil
	}
	branch = git.Branch                                // clean: the store hands out only cleaned text (#6832)
	pz, isPaused := gitguard.Get(git.WorkingDirectory) // live git updates are paused for this folder (#13079, #13092): the counts below are the last ones read, and the row and header say so
	if git.Worktree || git.BaseBranch != "" || isPaused {
		state := map[string]any{
			"is_worktree": git.Worktree,
			"base_branch": git.BaseBranch,
			"ahead":       git.Ahead,
			"behind":      git.Behind,
			"dirty":       git.DirtyCount,
		}
		if isPaused {
			state["paused"] = map[string]any{"changes": pz.Changes, "took_ms": pz.TookMs} // the files the Files list compared when it was last read (the selected comparison, committed ones included): not the uncommitted count, which stays dirty
		}
		gitState = state
	}
	if git.RemoteURL != nil {
		if rn := gitutil.ParseRepoName(*git.RemoteURL); rn != "" {
			repoName = rn
		}
	}
	return branch, repoName, gitState
}

// detachedCommit is the short commit a row names when its checkout is detached: git reports the branch of a detached checkout as the word HEAD, which every detached agent shares, so the dashboard
// cannot tell two agents on two worktrees apart (#11580). Nil for a checkout on a branch, or when the commit is unknown.
func detachedCommit(git *store.GitSnapshot) any {
	if git == nil || git.Branch != "HEAD" || len(git.CommitHash) < 7 {
		return nil
	}
	return git.CommitHash[:7]
}

// addCapabilities sets entry["capabilities"] to the stored JSON when present
// and valid; otherwise the key is left out.
func addCapabilities(entry map[string]any, raw *string) {
	if raw != nil && *raw != "" && json.Valid([]byte(*raw)) {
		entry["capabilities"] = json.RawMessage(*raw)
	}
}

// listTextFields returns status, summary, display_name and icon as both
// session lists send them: status and summary are null when empty,
// display_name is the stored name ("" when unset), and icon is null unless
// one is stored for the session.
func listTextFields(logInfo map[string]any, summary string, displayNames, icons map[string]string, sessionID string) (status, summ, displayName, icon any) {
	logStatus, _ := logInfo["status"].(string)
	status, summ, displayName = ptr.NullIfEmpty(logStatus), ptr.NullIfEmpty(summary), displayNames[sessionID]
	if ic, ok := icons[sessionID]; ok && sessionID != "" {
		icon = ic
	}
	return status, summ, displayName, icon
}

// archivedLast moves archived agents' rows to the end and keeps the order
// otherwise, so a reader that caps the list keeps live rows first (#3030).
func archivedLast(rows []map[string]any) []map[string]any {
	slices.SortStableFunc(rows, func(a, b map[string]any) int {
		aa, ba := a["archived"] == true, b["archived"] == true
		switch {
		case aa == ba:
			return 0
		case aa:
			return 1
		default:
			return -1
		}
	})
	return rows
}
