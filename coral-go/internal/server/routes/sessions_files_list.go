// A session's changed files: the list and its refresh (moved out of sessions_files.go, #5003; no behaviour change).

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/subgentic/coral/internal/logsafe"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/gitguard"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

// filesCacheFloor is how long a changed-files list stays fresh when nothing
// refreshes it in the background: polling turned off.
const filesCacheFloor = 30 * time.Second

// filesCacheMaxAge is how old a cached changed-files list may be before the
// Files handler recomputes it. The git poller rewrites the list for the
// compare mode in force, every git_poll_interval_s, so it stays fresh for two poll
// intervals in every mode. A list the poller has not rewritten since the mode changed
// is as old as its last write, so it is recomputed.
func (h *SessionsHandler) filesCacheMaxAge(ctx context.Context) time.Duration {
	settings, _ := h.ss.GetSettings(ctx)
	interval := background.GitPollInterval(settings, h.cfg.GitPollerIntervalS)
	if interval <= 0 {
		return filesCacheFloor
	}
	if interval < background.MinGitPollInterval {
		interval = background.MinGitPollInterval
	}
	return max(2*interval, filesCacheFloor)
}

// filesCacheFresh reports whether a cached list was written within maxAge.
// Every row of one list shares its recorded_at.
func filesCacheFresh(files []store.ChangedFile, maxAge time.Duration, now time.Time) bool {
	if len(files) == 0 {
		return false
	}
	recorded, err := time.Parse(store.ISOFormat, files[0].RecordedAt)
	if err != nil {
		return false
	}
	return now.Sub(recorded) <= maxAge
}

// Files returns changed files for a live agent.
// GET /api/sessions/live/{name}/files
// Returns the cached list for the user's current diff mode while it is
// fresh (see filesCacheMaxAge); otherwise computes it again, as a refresh
// does, so a list from before a rebase, merge or branch switch is never
// served as current.
func (h *SessionsHandler) Files(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sidPtr := querySessionID(r)
	if sid := ""; sidPtr != nil {
		sid = *sidPtr
		if !h.requireAgentSession(w, r, name, sid) {
			return
		}
	} else if !h.requireAgentSession(w, r, name, "") {
		return
	}

	diffMode := h.getDiffMode(r.Context())
	if diffMode == "" {
		diffMode = "branch_point"
	}

	files, found, err := h.gs.GetChangedFiles(r.Context(), name, sidPtr, diffMode)
	if r.URL.Query().Get("worktree") == "" && err == nil && found && filesCacheFresh(files, h.filesCacheMaxAge(r.Context()), time.Now()) {
		out := map[string]any{"agent_name": name, "files": hubVisibleFiles(r, files), "diff_mode": diffMode}
		if wd := h.resolveGitRoot(agentCtx(r), name, "", ptr.Value(sidPtr)); wd != "" {
			if pz, isPaused := gitguard.Get(wd); isPaused {
				out["paused"] = pz
				out["total_changed"] = max(pz.Changes, len(files))
			}
		}
		if workdir := h.resolveGitRoot(agentCtx(r), name, "", ptr.Value(sidPtr)); workdir != "" {
			out["compare"] = map[string]any{"mode": diffMode, "label": gitutil.CompareLabel(r.Context(), workdir, diffMode)}
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	sid := ""
	if sidPtr != nil {
		sid = *sidPtr
	}
	h.refreshFilesInner(w, r, name, sid, noRefreshFlags) // the View tier's read: Refresh and Turn on live updates are the POST's flags (Interact), never read here (#13127)
}

// RefreshFiles runs fresh git queries and merges agent Write/Edit events.
// POST /api/sessions/live/{name}/files/refresh
func (h *SessionsHandler) RefreshFiles(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		SessionID string `json:"session_id"`
	}
	decodeJSON(r, &body)
	q := r.URL.Query()
	flags := refreshFlags{manual: q.Get("manual") == "1", live: q.Get("live") == "on"}
	h.refreshFilesInner(w, r, name, body.SessionID, flags)
}

// refreshFlags are what a person's Refresh and Turn on live updates ask of one pass (#13079): manual runs a pass even for a paused folder, live also turns live updates back on. Only the POST refresh (Interact) passes them;
// the GET (View) never does, so a viewer can neither resume a paused folder nor force git to run (#13127).
type refreshFlags struct{ manual, live bool }

// noRefreshFlags is what a read passes. (The calls pass a plain name, not a literal: tools/gen_route_queries.py follows a helper that receives the request only through such a call, and the route's own parameters, worktree, are read inside it.)
var noRefreshFlags = refreshFlags{}

// trackedPaths reports which of the given repo-relative paths git tracks. It
// asks only about those paths, so the cost follows the number of candidates
// rather than the size of the repository. An empty list costs nothing.
func trackedPaths(ctx context.Context, workdir string, paths []string) map[string]bool {
	tracked := make(map[string]bool, len(paths))
	if len(paths) == 0 {
		return tracked
	}

	args := append([]string{"ls-files", "-z", "--"}, paths...)
	out, err := gitCmd(ctx, workdir, args...).Output()
	if err != nil {
		// Unknown tracked status: treat every candidate as untracked, which at
		// worst shows a clean file in the list rather than hiding a dirty one.
		warnGit("git ls-files (tracked) failed", err, "workdir", logsafe.Dir(workdir))
		return tracked
	}
	for _, f := range bytes.Split(out, []byte{0}) {
		if len(f) > 0 {
			tracked[string(f)] = true
		}
	}
	return tracked
}

// gitCmd builds a git command for the changed-files path. --no-optional-locks
// keeps a read-only query from refreshing and rewriting the index, which on a
// large repo means disk writes and lock contention on every poll.
func gitCmd(ctx context.Context, workdir string, args ...string) *exec.Cmd {
	return gitutil.Command(ctx, workdir, args...)
}

// refreshFilesInner contains the shared logic for computing fresh changed files.
func (h *SessionsHandler) refreshFilesInner(w http.ResponseWriter, r *http.Request, name, sessionID string, flags refreshFlags) {
	if !h.requireAgentSession(w, r, name, sessionID) {
		return
	}
	handlerBegan := time.Now()
	workdir := h.refreshWorkdir(agentCtx(r), name, sessionID)
	if workdir == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Could not determine working directory", "files": []any{}})
		return
	}
	follow := followOn(agentCtx(r))
	manual := flags.manual || flags.live
	if flags.live {
		gitguard.Resume(workdir) // 'Turn live updates on': this pass runs, and the poller takes the folder up again (it pauses it again if git is still slow)
	}
	if pz, isPaused := gitguard.Get(workdir); isPaused && !manual {
		// Live updates are paused for this folder (#13079): the stored list is the answer, no git runs (not even the repository check below: a paused folder is one); Refresh (manual=1) asks for one pass
		mode := h.getDiffMode(r.Context())
		if mode == "" {
			mode = "branch_point"
		}
		stored, _, _ := h.gs.GetChangedFiles(r.Context(), name, ptr.NonEmpty(sessionID), mode)
		// A followed worktree's list is never stored (it is not the launch folder's, which the poller writes): the last list a pass computed for it is the answer, or the panel shows nothing and the count of a list it never got (#13247)
		if last, ok := refreshFlights.lastFor(refreshFlightKey(workdir, h.getDiffMode(r.Context()), sessionID, follow, name)); follow && ok {
			stored = last.files
		}
		writeJSON(w, http.StatusOK, h.withWorktree(r, name, sessionID, map[string]any{"agent_name": name, "files": hubVisibleFiles(r, stored), "diff_mode": mode, "total_changed": max(pz.Changes, len(stored)), "capped": pz.Changes > len(stored),
			"paused": pz}))
		return
	}
	// A folder that is not a git repository has nothing to compare: the panel says so (#6072), and lists its recently changed files instead (#10256); this is an answer, not an error. (ResolveGitRoot gives the folder itself back when it finds no repository.)
	if gitutil.Available() {
		gitProbeHook()
		gctx, gcancel := context.WithTimeout(r.Context(), 5*time.Second)
		err := gitCmd(gctx, workdir, "rev-parse", "--is-inside-work-tree").Run()
		gcancel()
		if err != nil && r.Context().Err() == nil {
			// the folder's recently changed files stand in for the changes (#10256), inside the file viewer's bounds
			writeJSON(w, http.StatusOK, h.withWorktree(r, name, sessionID, map[string]any{"agent_name": name, "files": hubVisibleFiles(r, recentFilesInPlainFolder(workdir, !localDashboard(r))), "diff_mode": h.getDiffMode(r.Context()), "is_git": false}))
			return
		}
	}

	key := refreshFlightKey(workdir, h.getDiffMode(r.Context()), sessionID, follow, name)
	res, ran, ok := refreshFlights.do(r.Context(), key, manual, func() refreshedFiles {
		return h.computeRefreshedFiles(context.WithoutCancel(r.Context()), name, sessionID, workdir, follow)
	})
	if !ok {
		return // the page went away while it waited
	}
	var pausedNow any
	if ran {
		gitguard.Observe(workdir, res.total, max(res.took, time.Since(handlerBegan))) // the whole request counts, not only the pass: finding the repository is git too (#13079). A slow pass is a strike (two in a row pause the folder); a fast one clears them and turns live updates back on if they were paused
	}
	if pz, isPaused := gitguard.Get(workdir); isPaused {
		pausedNow = pz
	}
	writeJSON(w, http.StatusOK, h.withWorktree(r, name, sessionID, map[string]any{"agent_name": name, "files": hubVisibleFiles(r, res.files), "diff_mode": res.diffMode, "total_changed": res.total, "capped": res.total > len(res.files), "paused": pausedNow,
		"compare": map[string]any{"mode": res.diffMode, "label": res.label}}))
}

// refreshedFiles is one run of the changed-files queries: the list kept (cut to refreshFilesCap, by name), how many files changed in all, the mode and what it compares with.
type refreshedFiles struct {
	files    []store.ChangedFile
	total    int
	diffMode string
	label    string
	took     time.Duration
}

// refreshGitTimeout is how long one pass of the changed-files queries may run (a package var: the 35,000-file test gives a loaded machine longer).
var refreshGitTimeout = 10 * time.Second

// refreshComputeHook runs at the start of every pass (tests: count passes, make one slow).
var refreshComputeHook = func() {}

// computeRefreshedFiles runs the git queries for a folder and stores the list (#13079: it used to store and send every file, 35,000 of them, on every call).
func (h *SessionsHandler) computeRefreshedFiles(ctx0 context.Context, name, sessionID, workdir string, follow bool) refreshedFiles {
	refreshComputeHook()
	began := time.Now()
	// New files' line counts are read through the working tree held as a root (#3596 W5): a
	// symlinked folder on the way, a symlink, a FIFO or a device is never read. If the tree can't
	// be opened, new files count 0 lines.
	root, rootErr := safefs.OpenRoot(workdir)
	if rootErr == nil {
		defer root.Close()
	}
	lineCount := func(rel string) int {
		if rootErr != nil {
			return 0
		}
		return gitutil.NewFileLineCountIn(root, rel)
	}

	// Run git diff --numstat to get changed files
	ctx, cancel := context.WithTimeout(ctx0, refreshGitTimeout)
	defer cancel()

	diffMode := h.getDiffMode(ctx0)
	withTree := gitutil.IncludesWorkingTree(diffMode)
	out, moreChanged, err := gitutil.CappedNumstat(ctx, workdir, gitutil.DiffRefs(ctx, workdir, diffMode), refreshFilesCap, false) // a big tree is numbered for the rows kept only (#13155)
	fileMap := make(map[string]store.ChangedFile)
	if err != nil {
		warnGit("git diff --numstat failed", err, "agent_name", name, "workdir", logsafe.Dir(workdir))
	} else {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 3)
			if len(parts) < 3 {
				continue
			}
			adds, _ := strconv.Atoi(parts[0])
			dels, _ := strconv.Atoi(parts[1])
			fp := unquoteGitPath(parts[2]) // a name with a tab, a quote or a backslash is still quoted by git
			fileMap[fp] = store.ChangedFile{Filepath: fp, Additions: adds, Deletions: dels, Status: "M"}
		}
	}

	// Include untracked files (not for the last commit alone: they are not in it)
	untrackedSet := make(map[string]bool)
	var untracked []untrackedItem
	if withTree {
		// A big untracked folder is one row (its path ends in "/"), a small one its files (listUntracked, #12524).
		untracked, err = listUntracked(workdir, func(args ...string) ([]byte, error) { return gitCmd(ctx, workdir, args...).Output() })
	}
	if err != nil {
		warnGit("git ls-files (untracked) failed", err, "agent_name", name, "workdir", logsafe.Dir(workdir))
	} else {
		counted := 0
		for _, item := range untracked {
			f := item.Path
			untrackedSet[f] = true
			if _, exists := fileMap[f]; !exists {
				adds := 0
				if !item.Folded && counted < gitutil.MaxNewFileStatFiles {
					adds = lineCount(f)
					counted++
				}
				fileMap[f] = store.ChangedFile{Filepath: f, Additions: adds, Deletions: 0, Status: "??"}
			}
		}
	}

	// Files the agent wrote or edited that git has not already reported.
	// Collect the candidates first so their tracked status can be asked for by
	// pathspec: this used to list every tracked file in the repo to answer a
	// question about a handful of paths, which on a monorepo is the single
	// most expensive thing here.
	sidPtr := ptr.NonEmpty(sessionID)
	var events []store.AgentEvent
	if withTree { // what the agent wrote but git has not reported is working-tree work: not part of the last commit
		events, _ = h.ts.ListAgentEvents(ctx0, name, 200, sidPtr)
	}
	candidates := make([]string, 0, 16)
	seen := make(map[string]bool)
	for _, ev := range events {
		if ev.ToolName == nil || (*ev.ToolName != "Write" && *ev.ToolName != "Edit") {
			continue
		}
		if ev.DetailJSON == nil {
			continue
		}
		var detail map[string]any
		if err := json.Unmarshal([]byte(*ev.DetailJSON), &detail); err != nil {
			continue
		}
		fp, ok := detail["file_path"].(string)
		if !ok || fp == "" {
			continue
		}
		rel, err := filepath.Rel(workdir, fp)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if _, exists := fileMap[rel]; exists || seen[rel] {
			continue
		}
		seen[rel] = true
		candidates = append(candidates, rel)
	}

	trackedSet := trackedPaths(ctx, workdir, candidates)

	for _, rel := range candidates {
		// Skip files that no longer exist on disk, or aren't a regular file inside the tree (an
		// event's file_path comes from a hook payload; looked up through the root, #3596 W5)
		if rootErr != nil {
			continue
		}
		info, statErr := root.Lstat(rel)
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		// Skip tracked files not in fileMap — they have no diff (clean)
		if trackedSet[rel] && !untrackedSet[rel] {
			continue
		}
		fileMap[rel] = store.ChangedFile{
			Filepath:  rel,
			Additions: lineCount(rel),
			Deletions: 0,
			Status:    "??",
		}
	}

	// Annotate files with agent attribution from agent_events
	if sessionID != "" {
		if edits, err := h.ts.GetFileEdits(ctx0, sessionID, workdir); err == nil {
			for fp, agents := range edits {
				if f, exists := fileMap[fp]; exists {
					f.Agents = agents
					f.Source = "git"
					fileMap[fp] = f
				}
			}
		}
	}

	// Set source for files without explicit attribution
	for fp, f := range fileMap {
		if f.Source == "" {
			f.Source = "git"
			fileMap[fp] = f
		}
	}

	// Update DB cache. By name, and cut at refreshFilesCap: the list is stored and sent whole on every refresh, and 35,000 rows were (#13079); the total is said, not hidden.
	files := make([]store.ChangedFile, 0, len(fileMap))
	for _, f := range fileMap {
		files = append(files, f)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Filepath < files[j].Filepath })
	total := len(files) + moreChanged
	if total > refreshFilesCap {
		files = files[:refreshFilesCap]
	}
	if diffMode == "" {
		diffMode = "branch_point"
	}
	if !follow { // the cache is the launch folder's list (the poller writes it): a followed worktree's is not kept in its place (#11351)
		h.gs.ReplaceChangedFiles(ctx0, name, workdir, files, sidPtr, diffMode)
	}
	return refreshedFiles{files: files, total: total, diffMode: diffMode, label: gitutil.CompareLabel(ctx0, workdir, diffMode), took: time.Since(began)}
}

// refreshFilesCap is the most files one refresh stores and sends, the same as the background poller's cap.
const refreshFilesCap = background.MaxChangedFiles

// refreshFlight runs one refresh of a folder at a time (#13079): the Files panel asked every 4 s and each call ran git again, so a slow repo (3 s a pass) was queried back to back, several calls at once.
// A call that arrives while one runs waits for it and shares its answer; after a pass that took over refreshReuseOver, its answer is also reused for as long as that pass took, so the next ask is not a new pass.
type refreshFlight struct {
	mu     sync.Mutex
	calls  map[string]*refreshCall
	recent map[string]refreshRecent
	last   map[string]refreshKept // the newest answer of each key, kept for a paused folder that has no stored list to show (#13247)
	order  []string               // the keys of last, oldest first: the oldest goes when it is full
}

// refreshKept is a kept answer and when it was kept.
type refreshKept struct {
	res refreshedFiles
	at  time.Time
}

// refreshLastKeep bounds last: when it is full the OLDEST key goes (#13267), not all of them. refreshLastFor is how long an answer is kept: an agent that ended leaves its list for no longer than that.
const (
	refreshLastKeep = 256
	refreshLastFor  = time.Hour
)

// keep records the newest answer of key, dropping the answers older than refreshLastFor and, when full, the oldest key. The caller holds f.mu.
func (f *refreshFlight) keep(key string, res refreshedFiles, now time.Time) {
	if f.last == nil {
		f.last = map[string]refreshKept{}
	}
	if _, ok := f.last[key]; ok {
		for i, k := range f.order {
			if k == key {
				f.order = append(f.order[:i], f.order[i+1:]...)
				break
			}
		}
	}
	for len(f.order) > 0 && (len(f.order) >= refreshLastKeep || now.Sub(f.last[f.order[0]].at) > refreshLastFor) {
		delete(f.last, f.order[0])
		f.order = f.order[1:]
	}
	f.last[key] = refreshKept{res: res, at: now}
	f.order = append(f.order, key)
}

// lastFor is the newest list a pass computed for key.
func (f *refreshFlight) lastFor(key string) (refreshedFiles, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept, ok := f.last[key]
	if ok && time.Since(kept.at) > refreshLastFor {
		return refreshedFiles{}, false
	}
	return kept.res, ok
}

type refreshCall struct {
	done chan struct{}
	res  refreshedFiles
	ok   bool // fn returned (it did not panic)
}
type refreshRecent struct {
	res   refreshedFiles
	until time.Time
}

const refreshReuseOver = 250 * time.Millisecond

var refreshFlights = &refreshFlight{calls: map[string]*refreshCall{}, recent: map[string]refreshRecent{}, last: map[string]refreshKept{}}

// do returns the answer for key, running fn if nobody is (ran: this call ran the pass; false when it shared one); ok is false when ctx ended while waiting. fresh asks for a new pass whatever was just answered (a person's Refresh); a pass already running is still shared.
// The pass is left cleanly even if fn panics: the key is freed and the waiters released (they get an empty answer), so one panic cannot make every later refresh of the folder wait.
func (f *refreshFlight) do(ctx context.Context, key string, fresh bool, fn func() refreshedFiles) (res refreshedFiles, ran, ok bool) {
	f.mu.Lock()
	if rc, ok := f.recent[key]; ok {
		if !fresh && time.Now().Before(rc.until) {
			f.mu.Unlock()
			return rc.res, false, true
		}
		delete(f.recent, key)
	}
	if c, ok := f.calls[key]; ok {
		f.mu.Unlock()
		select {
		case <-c.done:
			return c.res, false, true
		case <-ctx.Done():
			return refreshedFiles{}, false, false
		}
	}
	c := &refreshCall{done: make(chan struct{})}
	f.calls[key] = c
	f.mu.Unlock()
	start := time.Now()
	defer func() {
		took := time.Since(start)
		f.mu.Lock()
		delete(f.calls, key)
		for k, rc := range f.recent {
			if !time.Now().Before(rc.until) {
				delete(f.recent, k)
			}
		}
		if c.ok { // a pass that panicked is not kept: its answer is empty
			f.keep(key, c.res, time.Now())
		}
		if took > refreshReuseOver && c.ok {
			f.recent[key] = refreshRecent{res: c.res, until: time.Now().Add(min(took, 10*time.Second))}
		}
		f.mu.Unlock()
		close(c.done)
	}()
	c.res = fn()
	c.ok = true
	return c.res, true, true
}

// refreshFlightKey is what one pass of git is shared by: the folder, the mode, the session, the follow state and the agent. The agent too: a pass stores that agent's own list and reads its own events, and an agent
// known by name alone (no session id) would otherwise share a pass with every other agent in its folder.
func refreshFlightKey(workdir, mode, sessionID string, follow bool, agent string) string {
	return fmt.Sprintf("%s\x00%s\x00%s\x00%v\x00%s", workdir, mode, sessionID, follow, agent)
}

// refreshRootTTL is how long the folder a files refresh resolved for an agent is kept: the resolution is git processes (the repository's top level, the followed worktree), and the Files panel asks every few seconds (#13079).
const refreshRootTTL = 5 * time.Second

// gitProbeHook runs before each git probe of the refresh path that is not the pass itself (tests: count the probes, make one slow).
var gitProbeHook = func() {}

// refreshRootNow is the clock of the folder cache (tests move it).
var refreshRootNow = time.Now

type refreshRoot struct {
	dir string
	at  time.Time
}

// refreshWorkdir is resolveGitRoot, kept for refreshRootTTL per agent, session, follow and strictness: a miss is not kept.
func (h *SessionsHandler) refreshWorkdir(ctx context.Context, name, sessionID string) string {
	key := fmt.Sprintf("%s\x00%s\x00%t\x00%t", name, sessionID, followOn(ctx), strictIdentity(ctx))
	if v, ok := h.refreshRoots.Load(key); ok {
		if rr := v.(refreshRoot); refreshRootNow().Sub(rr.at) < refreshRootTTL {
			return rr.dir
		}
	}
	gitProbeHook()
	dir := h.resolveGitRoot(ctx, name, "", sessionID)
	if dir == "" {
		h.refreshRoots.Delete(key)
		return ""
	}
	now := refreshRootNow()
	h.refreshRoots.Store(key, refreshRoot{dir: dir, at: now})
	h.refreshRoots.Range(func(k, v any) bool { // entries of ended sessions are not kept: every miss sweeps the expired ones (Security's INFO a on #13079)
		if now.Sub(v.(refreshRoot).at) >= refreshRootTTL {
			h.refreshRoots.Delete(k)
		}
		return true
	})
	return dir
}
