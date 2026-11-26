package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/store"
)

// A worker's own worktree (#21468, mocks v3 idea 3): "worker launch --worktree" starts the worker in worktree task-N, and "worker archive --remove-worktree" takes that one folder away when nothing in it is unsaved.
// Coral does not guess what to tidy: only a worktree a worker asked for at its launch is ever removed, only when it is clean, and the branch is always kept.

var taskWorktreeNameRE = regexp.MustCompile(`^task-[0-9]{1,12}$`)

// taskWorktreeName is the folder and the branch of a task's worktree: task-N.
func taskWorktreeName(task int64) string { return "task-" + strconv.FormatInt(task, 10) }

// recordTaskWorktree remembers the worktree a worker was started in, and gives its git row at once (the branch the dashboard shows).
func (h *SessionsHandler) recordTaskWorktree(ctx context.Context, sessionID string, task int64, path, repo string) {
	if h.ss == nil || repo == "" {
		return
	}
	if err := h.ss.SetTaskWorktree(ctx, store.TaskWorktree{SessionID: sessionID, TaskID: task, Name: taskWorktreeName(task), Path: path, Repo: repo}); err != nil {
		return
	}
	h.recordWorktreeRow(ctx, sessionID, path)
}

// worktreeAnswer is what an archive says about the worker's worktree: state "removed", "kept" or "none" (the worker has no worktree of its own to remove), the folder's name, and the words for a person.
type worktreeAnswer struct {
	State  string `json:"state"`
	Name   string `json:"name,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// removeTaskWorktree takes the worker's own worktree away when it is safe, and says what it did. Every check is here: the folder is the one recorded at the launch, is named task-N, sits directly in the
// repository's <repo>-worktrees folder, is not a link, is listed by its repository as a worktree (RemoveWorktree checks that again), and nobody else works in it. It is never forced and the branch is never
// deleted (the empty branch name keeps it).
func (h *SessionsHandler) removeTaskWorktree(ctx context.Context, sess *store.LiveSession) worktreeAnswer {
	tw, err := h.ss.GetTaskWorktree(ctx, sess.SessionID)
	if err != nil {
		return worktreeAnswer{State: "kept", Reason: "Coral could not read where the worker works"}
	}
	if tw == nil {
		return worktreeAnswer{State: "none", Reason: "this worker was not started with --worktree, so there is no worktree of its own to remove"}
	}
	keep := func(why string) worktreeAnswer { return worktreeAnswer{State: "kept", Name: tw.Name, Reason: why} }
	path := filepath.Clean(tw.Path)
	if !filepath.IsAbs(path) || !taskWorktreeNameRE.MatchString(tw.Name) || filepath.Base(path) != tw.Name || tw.Repo == "" || filepath.Dir(path) != defaultWorktreeDir(tw.Repo) {
		return keep("its folder is not where Coral made it")
	}
	fi, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) { // already gone: the registration is cleared and the answer is that nothing is left
			if out := h.removeOwnedWorktree(ctx, "archive", tw.Repo, path, ""); out.State == "removed" {
				return worktreeAnswer{State: "removed", Name: tw.Name}
			}
		}
		return keep("Coral could not look at its folder")
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return keep("its folder is not a plain folder")
	}
	if n, err := h.ss.OtherLiveInPath(ctx, sess.SessionID, path); err != nil || n > 0 {
		return keep("another agent works in it")
	}
	status, err := gitutil.Command(ctx, path, "status", "--porcelain=v1", "--untracked-files=normal").Output()
	if err != nil {
		return keep("git could not read it")
	}
	if text := strings.TrimSpace(string(status)); text != "" {
		files := len(strings.Split(text, "\n"))
		return keep(fmt.Sprintf("%d %s not committed. Nothing was removed.", files, plural(files, "file is", "files are")))
	}
	out := h.removeOwnedWorktree(ctx, "archive", tw.Repo, path, "") // "" for the branch: it is kept
	if out.State != "removed" {
		reason := out.Reason
		if reason == "" {
			reason = "git would not remove it"
		}
		return keep(reason + ". Nothing was removed.")
	}
	return worktreeAnswer{State: "removed", Name: tw.Name}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// recordWorktreeKept writes the Activity row for a worktree that was asked to go and was kept, so a kept folder is never a surprise: one row, the worker as the item, the reason as the note. agent is the Orchestrator that asked, "" for the person.
func (h *SessionsHandler) recordWorktreeKept(r *http.Request, sess *store.LiveSession, ans worktreeAnswer, agent string) {
	if h.bs == nil {
		return
	}
	label := deref(sess.DisplayName)
	if label == "" {
		label = sess.AgentName
	}
	m := activityMetaFor(r, label+" was archived, but its worktree was kept", ans.Reason)
	if agent != "" { // the Orchestrator that archived it (its stop command); the person's own Archive is the person's row
		m.Actor, m.Source, m.Hint, m.Surface = "agent:"+agent, "local", "", ""
		m.Asker = agent
	}
	team := ""
	if sess.BoardName != nil {
		team = *sess.BoardName
	}
	_ = h.bs.RecordActivity(context.WithoutCancel(r.Context()), m, board.ActWorktreeKept, "agent", sess.AgentName, "", team)
}
