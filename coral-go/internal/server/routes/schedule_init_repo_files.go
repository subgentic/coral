package routes

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/gitutil"
)

// maxFirstCommitFiles is how many files a first commit may take (#17211): a folder with more (a home folder's Documents, a disk of photos) is not staged at all, which would be a long git add into a repository
// the person never meant to be that big. The New job dialog warns before, and the server refuses.
var maxFirstCommitFiles = 20000

// countFolderFiles counts the files under dir (.git aside), stopping once there are more than limit: the number is exact up to it and "more than limit" after (capped true).
func countFolderFiles(dir string, limit int) (n int, capped bool) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == ".git" && p != dir {
				return filepath.SkipDir
			}
			return nil
		}
		n++
		if n > limit {
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
	}
	for _, ext := range []string{".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"} {
		if strings.HasSuffix(base, ext) {
			return true
		}
	}
	return false
}

// stageFirstCommit stages the folder's files for the first commit (git add -A, so .gitignore is honoured) and takes out the ones whose names look like secrets; it returns those names. When it fails (or
// the time runs out) the index is put back, so the folder is as it was (#17211): a half-staged index would make the next commit hold files the person never chose.
func stageFirstCommit(ctx context.Context, dir string) (left []string, err error, out string) {
	if b, aerr := gitutil.Command(ctx, dir, "add", "-A").CombinedOutput(); aerr != nil {
		unstage(dir)
		return nil, aerr, strings.TrimSpace(string(b))
	}
	listed, lerr := gitutil.Command(ctx, dir, "ls-files", "-z").Output()
	if lerr != nil {
		unstage(dir)
		return nil, lerr, ""
	}
	for _, name := range strings.Split(string(listed), "\x00") {
		if name != "" && secretLookingFile(name) {
			left = append(left, name)
		}
	}
	for i := 0; i < len(left); i += 100 {
		j := min(i+100, len(left))
		args := append([]string{"rm", "-q", "--cached", "--"}, left[i:j]...)
		if b, rerr := gitutil.Command(ctx, dir, args...).CombinedOutput(); rerr != nil {
			unstage(dir)
			return nil, rerr, strings.TrimSpace(string(b))
		}
	}
	return left, nil, ""
}

// unstage empties the index of a repository that has no commit yet (its own short time, not the request's: the request's may be the one that ran out).
func unstage(dir string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if gitutil.Command(ctx, dir, "reset", "-q").Run() != nil {
		_ = gitutil.Command(ctx, dir, "rm", "-r", "-q", "--cached", "--ignore-unmatch", ".").Run()
	}
}
