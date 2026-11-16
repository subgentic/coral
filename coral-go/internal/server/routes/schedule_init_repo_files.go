package routes

import (
	"bufio"
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/gitutil"
)

// maxFirstCommitFiles is how many files a first commit may take (#17211): a folder with more (a home folder's Documents, a disk of photos) is not staged at all, which would be a long git add into a repository
// the person never meant to be that big. The New job dialog warns before, and the server refuses.
var maxFirstCommitFiles = 20000

// countBudget bounds how long a count may take: a slow disk or a folder of many empty folders must not hold a folder pick (#17487). A count that runs out is reported as "more than" (capped).
var countBudget = 4 * time.Second

// countFolderFiles counts the files a first commit would take under dir: what git add -A stages, so .gitignore is honoured and node_modules in a small project is not counted (#17487). It stops once there
// are more than limit (the number is exact up to it, "more than limit" after), and when the time runs out. Without git it walks the folder, bounded too.
func countFolderFiles(ctx context.Context, dir string, limit int) (n int, capped bool) {
	ctx, cancel := context.WithTimeout(ctx, countBudget)
	defer cancel()
	if n, capped, ok := countWithGit(ctx, dir, limit); ok {
		return n, capped
	}
	return walkCount(ctx, dir, limit)
}

// countWithGit lists the files git would stage and counts them as they arrive; ok is false when git could not do it. The folder need not be a repository: git is pointed at an empty scratch repository with the
// folder as its work tree, so every file that .gitignore does not exclude is "untracked" and listed.
func countWithGit(ctx context.Context, dir string, limit int) (n int, capped, ok bool) {
	scratch, err := os.MkdirTemp("", "coral-count-")
	if err != nil {
		return 0, false, false
	}
	defer os.RemoveAll(scratch)
	if gitutil.Command(ctx, "", "init", "-q", "--bare", scratch).Run() != nil {
		return 0, false, false
	}
	cmd := gitutil.Command(ctx, dir, "ls-files", "-z", "--others", "--exclude-standard")
	cmd.Env = append(cmd.Env, "GIT_DIR="+scratch, "GIT_WORK_TREE="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return 0, false, false
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if i := bytes.IndexByte(data, 0); i >= 0 {
			return i + 1, data[:i], nil
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for sc.Scan() {
		if n++; n > limit {
			capped = true
			break
		}
	}
	if capped || ctx.Err() != nil { // enough counted, or out of time: stop git and report "more than"
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return n, true, true
	}
	if cmd.Wait() != nil || sc.Err() != nil {
		return 0, false, false
	}
	return n, false, true
}

// walkCount is the count without git: every file under dir (.git aside), at most limit+1, and no more than 4 times that many entries seen, so a tree of empty folders ends too.
func walkCount(ctx context.Context, dir string, limit int) (n int, capped bool) {
	seen := 0
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if seen++; seen > 4*(limit+1) || ctx.Err() != nil {
			capped = true
			return fs.SkipAll
		}
		if d.IsDir() {
			if d.Name() == ".git" && p != dir {
				return filepath.SkipDir
			}
			return nil
		}
		if n++; n > limit {
			capped = true
			return fs.SkipAll
		}
		return nil
	})
	return n, capped
}

// secretLookingFile is whether a file's name is one that usually holds a secret: environment files, private keys, certificates and credential files. A first commit leaves them out even when .gitignore does not
// list them, since every run of the job works in a copy made from that commit (#17211).
func secretLookingFile(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	switch {
	case base == ".env", base == ".netrc", base == ".npmrc", base == ".pypirc":
		return true
	case strings.HasPrefix(base, ".env."):
		for _, ok := range []string{".example", ".sample", ".template", ".dist"} {
			if strings.HasSuffix(base, ok) {
				return false
			}
		}
		return true
	case strings.HasPrefix(base, "id_") && !strings.HasSuffix(base, ".pub"):
		return true
	case strings.HasPrefix(base, "credentials"), strings.HasPrefix(base, "secrets."):
		return true
	case base == ".git-credentials", base == ".htpasswd", strings.Contains(base, ".tfstate"): // .tfstate.backup too
		return true
	}
	for _, ext := range []string{".pem", ".key", ".p12", ".pfx", ".p8", ".keystore", ".jks", ".kdbx", ".tfvars"} {
		if strings.HasSuffix(base, ext) {
			return true
		}
	}
	return false
}

// indexSnapshot is the index as it was before Coral staged anything, so a failure puts back exactly that: files the person staged first stay staged (#17487).
type indexSnapshot struct {
	path    string
	data    []byte
	existed bool
}

func takeIndexSnapshot(dir string) indexSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := gitutil.Command(ctx, dir, "rev-parse", "--path-format=absolute", "--git-path", "index").Output()
	if err != nil {
		return indexSnapshot{}
	}
	snap := indexSnapshot{path: strings.TrimSpace(string(out))}
	if b, rerr := os.ReadFile(snap.path); rerr == nil {
		snap.data, snap.existed = b, true
	}
	return snap
}

// restore puts the index back; false when it could not (the caller then falls back to emptying it).
func (s indexSnapshot) restore() bool {
	if s.path == "" {
		return false
	}
	if !s.existed {
		err := os.Remove(s.path)
		return err == nil || os.IsNotExist(err)
	}
	return os.WriteFile(s.path, s.data, 0o644) == nil
}

// stageFirstCommit stages the folder's files for the first commit (git add -A, so .gitignore is honoured) and takes out the ones whose names look like secrets; it returns those names. Files the person had
// already staged are left as they were. When it fails (or the time runs out) the index is put back, so the folder is as it was (#17211): a half-staged index would make the next commit hold files the person never chose.
func stageFirstCommit(ctx context.Context, dir string) (left []string, snap indexSnapshot, err error, out string) {
	snap = takeIndexSnapshot(dir)
	before := map[string]bool{}
	if b, lerr := gitutil.Command(ctx, dir, "ls-files", "-z").Output(); lerr == nil {
		for _, name := range strings.Split(string(b), "\x00") {
			before[name] = true
		}
	}
	if b, aerr := gitutil.Command(ctx, dir, "add", "-A").CombinedOutput(); aerr != nil {
		snap.undo(dir)
		return nil, snap, aerr, strings.TrimSpace(string(b))
	}
	listed, lerr := gitutil.Command(ctx, dir, "ls-files", "-z").Output()
	if lerr != nil {
		snap.undo(dir)
		return nil, snap, lerr, ""
	}
	for _, name := range strings.Split(string(listed), "\x00") {
		if name != "" && !before[name] && secretLookingFile(name) {
			left = append(left, name)
		}
	}
	for i := 0; i < len(left); i += 100 {
		j := min(i+100, len(left))
		args := append([]string{"rm", "-q", "--cached", "--"}, left[i:j]...)
		cmd := gitutil.Command(ctx, dir, args...)
		cmd.Env = append(cmd.Env, "GIT_LITERAL_PATHSPECS=1") // a file named id_* or [a].pem is that file, not a pattern that also takes others out (#17487)
		if b, rerr := cmd.CombinedOutput(); rerr != nil {
			snap.undo(dir)
			return nil, snap, rerr, strings.TrimSpace(string(b))
		}
	}
	return left, snap, nil, ""
}

// undo puts the index back as it was before staging (its own short time, not the request's: the request's may be the one that ran out). When the saved index cannot be put back, the index is emptied as the
// last resort, which is right for the usual case of a repository that had nothing staged.
func (s indexSnapshot) undo(dir string) {
	if s.restore() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if gitutil.Command(ctx, dir, "reset", "-q").Run() != nil {
		_ = gitutil.Command(ctx, dir, "rm", "-r", "-q", "--cached", "--ignore-unmatch", ".").Run()
	}
}
