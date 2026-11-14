// Work a team left uncommitted in the person's own folder (#17203, walk 55): the agents edit the folder in place, a goal is closed as done, and nothing said "your files are changed but not committed". The page
// reads the folders here and offers one local Commit. Both routes are the Operator's: an agent's token and Coral Hub cannot (identity_routes.go).

package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

const (
	maxUncommittedShown = 200
	commitTimeout       = 60 * time.Second
	maxCommitMessage    = 4000
	maxCommitOutput     = 4000
)

type uncommittedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "changed" or "new"
}

type uncommittedRepo struct {
	Folder     string            `json:"folder"`
	Changed    int               `json:"changed"`
	New        int               `json:"new"`
	Files      []uncommittedFile `json:"files"`
	SecretLike []string          `json:"secret_like"` // files whose names look like secrets: Commit leaves them out unless the person includes them
	Signing    bool              `json:"signing"`     // their git config asks for signed commits: Coral's commit is unsigned
	Truncated  bool              `json:"truncated"`
}

// secretLikeName reports whether a file's name looks like it holds a secret: an environment file, a key, a credentials file.
func secretLikeName(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	switch {
	case base == ".env" || (strings.HasPrefix(base, ".env.") && !strings.HasSuffix(base, ".example") && !strings.HasSuffix(base, ".sample") && !strings.HasSuffix(base, ".template")):
		return true
	case base == ".npmrc" || base == ".netrc" || base == ".pypirc":
		return true
	case strings.HasSuffix(base, ".pem") || strings.HasSuffix(base, ".key") || strings.HasSuffix(base, ".p12") || strings.HasSuffix(base, ".pfx"):
		return true
	case strings.HasPrefix(base, "id_rsa") || strings.HasPrefix(base, "id_ed25519") || strings.HasPrefix(base, "id_ecdsa"):
		return !strings.HasSuffix(base, ".pub")
	case strings.HasPrefix(base, "credentials") || strings.HasPrefix(base, "secrets."):
		return true
	}
	return false
}

// teamRepoFolders are the git work trees a team's agents work in: the team's home folder and the working folder of each of its agents, each taken to the top of its work tree, with its links resolved, once.
// The home folder and the root of the disk are never one (a repository there would hold everything in it).
func (h *SessionsHandler) teamRepoFolders(ctx context.Context, team *store.Team) []string {
	cands := []string{team.WorkingDir}
	if ids, err := h.ss.SessionIDsOfTeam(ctx, team.ID); err == nil {
		for _, id := range ids {
			if ls, err := h.ss.GetLiveSession(ctx, id); err == nil && ls != nil && ls.IsArchived == 0 {
				cands = append(cands, ls.WorkingDir)
			}
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, c := range cands {
		if c == "" || !filepath.IsAbs(c) {
			continue
		}
		real, err := safefs.Resolve(filepath.Clean(c))
		if err != nil {
			continue
		}
		if info, err := os.Stat(real); err != nil || !info.IsDir() {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		top := gitutil.TopLevel(cctx, real)
		cancel()
		if top == "" {
			continue
		}
		if top, err = safefs.Resolve(top); err != nil || homeOrRootRefusal(top) != "" || seen[top] {
			continue
		}
		seen[top] = true
		out = append(out, top)
	}
	return out
}

func repoUncommitted(ctx context.Context, folder string) (uncommittedRepo, bool) {
	changed, added, truncated, err := gitutil.Uncommitted(ctx, folder)
	if err != nil || len(changed)+len(added) == 0 {
		return uncommittedRepo{}, false
	}
	r := uncommittedRepo{Folder: folder, Changed: len(changed), New: len(added), Files: []uncommittedFile{}, SecretLike: []string{}, Truncated: truncated}
	for _, p := range changed {
		if len(r.Files) < maxUncommittedShown {
			r.Files = append(r.Files, uncommittedFile{Path: p, Status: "changed"})
		}
		if secretLikeName(p) {
			r.SecretLike = append(r.SecretLike, p)
		}
	}
	for _, p := range added {
		if len(r.Files) < maxUncommittedShown {
			r.Files = append(r.Files, uncommittedFile{Path: p, Status: "new"})
		}
		if secretLikeName(p) {
			r.SecretLike = append(r.SecretLike, p)
		}
	}
	if out, err := gitutil.Command(ctx, folder, "config", "--get", "commit.gpgsign").Output(); err == nil {
		r.Signing = strings.TrimSpace(string(out)) == "true"
	}
	return r, true
}

// TeamUncommitted lists the team's folders that have work not yet committed.
// GET /api/teams/detail/{name}/uncommitted
func (h *SessionsHandler) TeamUncommitted(w http.ResponseWriter, r *http.Request) {
	team, err := h.teamStore.GetTeam(r.Context(), chi.URLParam(r, "name"))
	if err != nil || team == nil {
		errNotFound(w, "team not found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	repos := []uncommittedRepo{}
	if gitutil.Available() {
		for _, folder := range h.teamRepoFolders(ctx, team) {
			if repo, ok := repoUncommitted(ctx, folder); ok {
				repos = append(repos, repo)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": repos})
}

// TeamCommit makes one local commit of what the team left in one of its folders: the files the list shows, no secret-looking file unless the person says so. Nothing is pushed; the repository's hooks are not run (every
// git call goes through gitutil.Command); signing is off. A failed commit shows git's words and leaves the index as it was.
// POST /api/teams/detail/{name}/commit {"folder": "...", "message": "...", "include_secret_like": false}
func (h *SessionsHandler) TeamCommit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Folder            string `json:"folder"`
		Message           string `json:"message"`
		IncludeSecretLike bool   `json:"include_secret_like"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	msg := strings.TrimSpace(strings.ReplaceAll(body.Message, "\x00", ""))
	if msg == "" {
		errBadRequest(w, "Write a message for the commit.")
		return
	}
	if len(msg) > maxCommitMessage {
		errBadRequest(w, "That message is too long for a commit.")
		return
	}
	team, err := h.teamStore.GetTeam(r.Context(), chi.URLParam(r, "name"))
	if err != nil || team == nil {
		errNotFound(w, "team not found")
		return
	}
	if !gitutil.Available() {
		errBadRequest(w, "git is not installed on this computer")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), commitTimeout)
	defer cancel()
	folder := ""
	if want, err := safefs.Resolve(filepath.Clean(body.Folder)); err == nil && filepath.IsAbs(body.Folder) {
		for _, f := range h.teamRepoFolders(ctx, team) {
			if f == want {
				folder = f
			}
		}
	}
	if folder == "" {
		errBadRequest(w, "That folder is not one this team works in.")
		return
	}
	changed, added, _, err := gitutil.Uncommitted(ctx, folder)
	if err != nil {
		errBadRequest(w, "git could not read that folder")
		return
	}
	var paths []string
	for _, p := range append(changed, added...) {
		if !body.IncludeSecretLike && secretLikeName(p) {
			continue
		}
		paths = append(paths, p)
	}
	if len(paths) == 0 {
		writeError(w, http.StatusConflict, "nothing_to_commit", "There is nothing to commit in that folder.")
		return
	}
	sort.Strings(paths)
	before := map[string]bool{} // what was staged before: Commit puts back only what it staged itself
	if out, err := gitutil.Command(ctx, folder, "diff", "--cached", "--name-only", "-z").Output(); err == nil {
		for _, p := range strings.Split(string(out), "\x00") {
			before[p] = true
		}
	}
	var mine []string
	for _, p := range paths {
		if !before[p] {
			mine = append(mine, p)
		}
	}
	undo := func() {
		if len(mine) > 0 {
			gitutil.Command(context.Background(), folder, append([]string{"reset", "-q", "--"}, mine...)...).Run() //nolint:errcheck // best effort: the commit already failed
		}
	}
	if out, err := gitutil.Command(ctx, folder, append([]string{"add", "--"}, paths...)...).CombinedOutput(); err != nil {
		undo()
		commitFailed(w, "git could not stage the files", out)
		return
	}
	args := []string{}
	for key, fallback := range map[string]string{"user.name": "Coral", "user.email": "coral@localhost"} { // the person's own identity when git has one
		if out, _ := gitutil.Command(ctx, folder, "config", key).Output(); strings.TrimSpace(string(out)) == "" {
			args = append(args, "-c", key+"="+fallback)
		}
	}
	args = append(args, "-c", "commit.gpgsign=false", "commit", "-m", msg)
	if out, err := gitutil.Command(ctx, folder, args...).CombinedOutput(); err != nil {
		undo()
		commitFailed(w, "git could not make the commit", out)
		return
	}
	sha := ""
	if out, err := gitutil.Command(ctx, folder, "rev-parse", "--short", "HEAD").Output(); err == nil {
		sha = strings.TrimSpace(string(out))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "folder": folder, "commit": sha, "files": len(paths)})
}

func commitFailed(w http.ResponseWriter, why string, out []byte) {
	text := strings.TrimSpace(string(out))
	if len(text) > maxCommitOutput {
		text = text[:maxCommitOutput] + "…"
	}
	writeJSON(w, http.StatusConflict, map[string]any{"error": why + ".", "code": "commit_failed", "output": text})
}
