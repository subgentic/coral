package routes

import (
	"net/http"

	"github.com/subgentic/coral/internal/store"
)

// A job's "Trust this folder" box (#16421, Security's conditions): a run of the job trusts exactly the worktree it made for itself, so the agent CLI's trust card does not stop an unattended run. The box is off
// by default and is the person's own decision for their own folder:
//   - only the person's own dashboard sets it (trustFolderCaller): an agent's token, a request through Coral Hub and the command line are refused, so a job an agent makes, an edit an agent makes and a copy a
//     Hub-shared template makes all arrive with it off. Any caller may turn it off.
//   - it holds for the folder it was set for: changing the job's folder, or the way it runs (no worktree) or its agent to one that has no card Coral can set, clears it unless the person's own request
//     sets it again in the same save.
//   - only for a prompt job of Claude or Codex that runs in a worktree.

// trustWorktreeFlag reads a request's trust_worktree as 0 or 1.
func trustWorktreeFlag(v interface{}) (int, bool) {
	switch n := v.(type) {
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	case float64:
		if n == 0 || n == 1 {
			return int(n), true
		}
	}
	return 0, false
}

// trustTickRefusal is why the box may not be set on a job of this shape by this request, "" when it may; status is the HTTP status for the reason.
func trustTickRefusal(r *http.Request, jobType, agentType string, noWorktree int) (status int, why string) {
	if !trustFolderCaller(r) {
		return http.StatusForbidden, "only the person's own dashboard can tick Trust this folder for a job"
	}
	if jobType != "" && jobType != "prompt" {
		return http.StatusBadRequest, "Trust this folder is for a prompt job"
	}
	if agentType != "" && agentType != "claude" && agentType != "codex" {
		return http.StatusBadRequest, "Trust this folder is for Claude and Codex jobs"
	}
	if noWorktree == 1 {
		return http.StatusBadRequest, "a job that runs in its folder itself has no worktree to trust"
	}
	return 0, ""
}

// applyTrustTick settles the trust_worktree of an update in fields, given the job as it is now (nil when unknown): a request to set it is checked, and a change that makes the old tick stale clears it. It
// reports false after answering the request itself.
func applyTrustTick(w http.ResponseWriter, r *http.Request, fields map[string]interface{}, existing *store.ScheduledJob) bool {
	jobType, agentType, noWT, repo := "", "", 0, ""
	if existing != nil {
		jobType, agentType, noWT, repo = existing.JobType, existing.AgentType, existing.NoWorktree, existing.RepoPath
	}
	if s, ok := fields["job_type"].(string); ok {
		jobType = s
	}
	if s, ok := fields["agent_type"].(string); ok {
		agentType = s
	}
	if n, ok := trustWorktreeFlag(fields["no_worktree"]); ok {
		noWT = n
	}
	newRepo, repoChanged := fields["repo_path"].(string)
	repoChanged = repoChanged && existing != nil && newRepo != repo
	if v, ok := fields["trust_worktree"]; ok {
		want, valid := trustWorktreeFlag(v)
		if !valid {
			errBadRequest(w, "'trust_worktree' must be 0 or 1")
			return false
		}
		fields["trust_worktree"] = want
		if want == 1 {
			if status, why := trustTickRefusal(r, jobType, agentType, noWT); status != 0 {
				writeError(w, status, "", why)
				return false
			}
			return true // the person's own save, set again for the folder as it is now
		}
		return true
	}
	if existing != nil && existing.TrustWorktree == 1 {
		stale := repoChanged || noWT == 1 || (agentType != "claude" && agentType != "codex") || (jobType != "" && jobType != "prompt")
		if stale {
			fields["trust_worktree"] = 0
		}
	}
	return true
}
