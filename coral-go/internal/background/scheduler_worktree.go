package background

import (
	"context"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/coralnames"
	"github.com/subgentic/coral/internal/logsafe"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/store"
)

// runWorktreeDir is where run runID's worktree of repoPath goes:
// <worktreeRoot>/job-run-<id>-<repo name>, or beside the repository when no
// root is set.
func (s *JobScheduler) runWorktreeDir(repoPath string, runID int64) string {
	if s.worktreeRoot != "" {
		_ = os.MkdirAll(s.worktreeRoot, 0o755)
	}
	return coralnames.JobRunWorktree(s.worktreeRoot, repoPath, runID)
}

// cleanupSettledWorktree removes the worktree of a run settled or adopted at startup, as a run that ended in-process has its removed: by the same no-force rule (a worktree with unsaved work stays, with its branch),
// and only for a job that asks for cleanup and only the folder the scheduler makes for that run (IsRunWorktreeFolder: never the job's own repository). A one-shot's cleanup flag is not stored, so a one-shot
// run's worktree stays (and shows in the kept-worktrees list). Without it a job every 5 minutes, restarted once, would leave one stale worktree.
func (s *JobScheduler) cleanupSettledWorktree(ctx context.Context, run store.ScheduledRun, job store.ScheduledJob) {
	fresh, err := s.store.GetScheduledRun(ctx, run.ID)
	if err != nil || fresh == nil || fresh.WorktreePath == nil || job.CleanupWorktree != 1 || job.RepoPath == "" {
		return
	}
	path := *fresh.WorktreePath
	if !coralnames.IsJobRunWorktree(s.worktreeRoot, job.RepoPath, run.ID, path) {
		return
	}
	base, err := gitutil.ResolveBase(ctx, job.RepoPath, job.BaseBranch)
	if err != nil {
		base = "" // the run's branch is then kept: it cannot be compared with a base
	}
	s.cleanupWorktree(job.RepoPath, path, coralnames.JobRunBranch(run.ID), base)
}

// runWorktree is where a run's agent works: the repository, or a worktree made for the run on its own branch.
type runWorktree struct {
	workingDir, worktreeDir, runBranch, baseBranch string
}

// prepareRunWorktree makes the run's worktree when the job asks for one, branching coral/job-run-<id> from the base
// branch (main by default): git refuses to check out a branch that is already checked out in another worktree, and
// the user's own working copy almost always has the base branch checked out, which is exactly what our docs give as
// the default, so checking out the base directly failed on every run of a correctly configured job. The worktree
// is keyed on the run, and the branch the same way, so each run stays isolated. A base branch refused (a stored job
// is checked again, #3601 weak site W24) or a worktree that can't be made fails the run (ok false).
func (s *JobScheduler) prepareRunWorktree(ctx, watchCtx context.Context, runID int64, rc runConfig) (runWorktree, bool) {
	wt := runWorktree{workingDir: rc.repoPath}
	if !rc.createWorktree || rc.repoPath == "" {
		return wt, true
	}
	wt.worktreeDir = s.runWorktreeDir(rc.repoPath, runID)
	wt.baseBranch = rc.baseBranch
	wt.runBranch = coralnames.JobRunBranch(runID)
	// The base branch the job names, else the repository's current branch: a job stored with the old default "main" runs in a repository on master too (#6701).
	var err error
	errMsg := ""
	errCode := "worktree_failed" // the fixed word a row and the Runs table show (#6701)
	if wt.baseBranch, err = gitutil.ResolveBase(watchCtx, rc.repoPath, wt.baseBranch); err != nil {
		var missing *gitutil.BranchMissingError
		if errors.As(err, &missing) {
			errMsg, errCode = missing.Error(), "base_branch_missing" // one plain sentence, no git text
		} else if errors.Is(err, gitutil.ErrNoCommits) {
			errMsg = `The run could not start: the repository has no commits yet. Make a first commit, or turn on "Run in the folder itself".` // the person's words and the way out, not git's (#10558)
		} else {
			errMsg = fmt.Sprintf("git worktree add failed: %v", err)
		}
	} else if err = gitutil.ValidRef(wt.baseBranch); err != nil {
		errMsg = fmt.Sprintf("base_branch refused: %v", err)
	} else if existing := s.runWorktreeExisting(watchCtx, rc.repoPath, wt.worktreeDir, wt.runBranch); existing != "" { // older leftovers of this id are never touched, nor rolled back over (#6927)
		err = errors.New(existing)
		errMsg = existing
	} else if err = runGitCmd(watchCtx, rc.repoPath, "-c", "core.longpaths=true", "worktree", "add", "-b", wt.runBranch, "--", wt.worktreeDir, wt.baseBranch); err != nil {
		errMsg = fmt.Sprintf("git worktree add failed: %v", err)
		s.rollBackWorktreeAdd(rc.repoPath, wt.worktreeDir, wt.runBranch, runID)
	}
	if err != nil {
		if s.shuttingDown() { // the shutdown ended the add, not a failure of the run's: not written as failed, the next start settles the row (#6927)
			return wt, false
		}
		s.logger.Error(errMsg, "run_id", runID)
		now := time.Now().UTC().Format(store.ISOFormat)
		s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
			"status":      "failed",
			"error_msg":   errMsg,
			"error_code":  errCode,
			"finished_at": now,
		})
		return wt, false
	}
	wt.workingDir = wt.worktreeDir
	return wt, true
}

// runWorktreeExisting says, in one plain sentence, whether the folder or the branch this run is about to make is already there ("" when neither is): a run id that repeats finds an older run's. The add is then not
// attempted, so the rollback only ever removes what this run's add made.
func (s *JobScheduler) runWorktreeExisting(ctx context.Context, repoPath, dir, branch string) string {
	if _, err := os.Lstat(dir); err == nil {
		return "the run's worktree folder already exists"
	}
	// Only git's clean "not found" (exit status 1 with --quiet) says the branch is not there: any other failure (a cancelled context, a broken repository) is unknown, and the add is refused (#6936).
	err := gitutil.Command(ctx, repoPath, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return "the run's branch already exists"
	case errors.As(err, &exit) && exit.ExitCode() == 1:
		return ""
	default:
		return "git could not tell whether the run's branch already exists"
	}
}

// rollBackWorktreeAdd leaves no folder, registration or branch of a worktree add that failed (#6717). It runs on a context of its own: a shutdown that ended the add (killing git halfway, folder and registration made)
// cancels the run's context, and a rollback on it would do nothing (#6927). The folder is removed only when it is the one the scheduler makes for this run.
func (s *JobScheduler) rollBackWorktreeAdd(repoPath, dir, branch string, runID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if coralnames.IsJobRunWorktree(s.worktreeRoot, repoPath, runID, dir) {
		err := os.RemoveAll(dir) // a half-made checkout git was killed in
		if err != nil {          // on Windows a git killed halfway may hold files for a moment
			time.Sleep(300 * time.Millisecond)
			if err = os.RemoveAll(dir); err != nil {
				s.logger.Warn("could not remove the half-made worktree folder", "path", logsafe.Dir(dir), "error", err)
			}
		}
	}
	runGitCmd(ctx, repoPath, "worktree", "prune")
	runGitCmd(ctx, repoPath, "branch", "-D", "--", branch)
}

// createWorktree creates a git worktree for an isolated job run.
func runGitCmd(ctx context.Context, repoPath string, args ...string) error {
	cmd := gitutil.Command(ctx, repoPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, string(out))
	}
	return nil
}

// cleanupWorktree removes a job run's worktree, and its per-run branch when
// that branch holds nothing.
//
// The branch is only deleted when it has no commits the base does not already
// have. Removing a worktree discards uncommitted work by design, but deleting
// a branch the agent committed to would make finished work unreachable, so a
// run that produced commits leaves its branch behind for the user to find.
func (s *JobScheduler) cleanupWorktree(repoPath, worktreePath, runBranch, baseBranch string) {
	if filepath.Clean(worktreePath) == filepath.Clean(repoPath) { // never the job's own repository, which may be a person's checkout (#6736)
		return
	}
	if s.shuttingDown() { // its own context outlives a shutdown: a removal reached while Coral stops would take a folder a live agent works in (#6918, #6927)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := runGitCmd(ctx, repoPath, "worktree", "remove", "--", worktreePath) // no --force: git keeps a worktree with unsaved work, and so does the branch (#6701)
	if err != nil {
		s.logger.Warn("kept the run's worktree: git would not remove it", "path", logsafe.Dir(worktreePath), "error", err)
		return
	}
	s.logger.Info("cleaned up worktree", "path", logsafe.Dir(worktreePath))

	if runBranch == "" || baseBranch == "" {
		return
	}
	if branchHasCommits(ctx, repoPath, baseBranch, runBranch) {
		s.logger.Info("keeping job run branch — it has commits",
			"branch", runBranch, "base", baseBranch)
		return
	}
	if err := runGitCmd(ctx, repoPath, "branch", "-D", runBranch); err != nil {
		s.logger.Warn("failed to delete job run branch", "branch", runBranch, "error", err)
	}
}

// branchHasCommits reports whether branch contains commits that base does not.
// On any error it answers true, so an unreadable repository leaves the branch
// alone rather than risking the deletion of real work.
func branchHasCommits(ctx context.Context, repoPath, base, branch string) bool {
	if gitutil.ValidRef(base) != nil || gitutil.ValidRef(branch) != nil {
		return true // never pass git an option; an unreadable answer keeps the branch
	}
	out, err := gitutil.Command(ctx, repoPath,
		"rev-list", "--count", base+".."+branch, "--").Output()
	if err != nil {
		return true
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return true
	}
	return n > 0
}
