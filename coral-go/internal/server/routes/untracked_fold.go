package routes

import (
	"bytes"
	"fmt"
	"github.com/subgentic/coral/internal/gitutil"
	"os"
	"path/filepath"
)

// Untracked folders in the changes views (#12524). A tool that writes hundreds of machine files into a folder of its own (a sync tool's trace folder) made the live diff, the stored diff and the changed-files list each
// grow a row per file. A BIG untracked folder is now one entry, as `git status` shows it; a small one (a new package an agent just wrote) stays file by file, so its code can still be reviewed. No name decides it:
// only how many files and how many bytes.
const (
	foldFilesOver = gitutil.UntrackedFoldFilesOver // a folder with more untracked files than this is folded
	foldBytesOver = gitutil.UntrackedFoldBytesOver // or with more than this many bytes in them
	foldStatMax   = 5000                           // files whose size is read for the note: the count is always exact, the size is "at least" past this
)

// untrackedItem is one untracked path: a file, or a big folder folded to one entry (Path ends in "/", Files and Bytes say what is in it).
type untrackedItem struct {
	Path       string
	Folded     bool
	Files      int
	Bytes      int64
	BytesExact bool
}

// size is the folded folder's size in words for a note.
func (u untrackedItem) size() string {
	more := ""
	if !u.BytesExact {
		more = "at least "
	}
	switch {
	case u.Bytes >= 1<<20:
		return fmt.Sprintf("%s%.1f MB", more, float64(u.Bytes)/(1<<20))
	case u.Bytes >= 1<<10:
		return fmt.Sprintf("%s%d KB", more, u.Bytes>>10)
	}
	return fmt.Sprintf("%s%d bytes", more, u.Bytes)
}

// foldedNote is the one line a folded folder is shown as (git apply skips it).
func (u untrackedItem) foldedNote() string {
	return fmt.Sprintf("new folder %q: %d untracked files, %s, shown as one entry as git status shows it", u.Path, u.Files, u.size())
}

// listUntracked lists the untracked paths of a working tree, honouring every ignore rule (--exclude-standard: .gitignore, .git/info/exclude, core.excludesFile). run runs git in the tree. An untracked folder
// that is empty, or holds only ignored files, is not listed (--no-empty-directory), as git status does not list it. A big folder is one folded item; a small one is its files; an untracked file in a folder that
// has tracked files is its own item, as git status lists it.
func listUntracked(workdir string, run func(args ...string) ([]byte, error)) ([]untrackedItem, error) {
	out, err := run("ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z")
	if err != nil {
		return nil, err
	}
	var items []untrackedItem
	for _, raw := range bytes.Split(out, []byte{0}) {
		if len(raw) == 0 {
			continue
		}
		p := string(raw)
		if p[len(p)-1] != '/' {
			items = append(items, untrackedItem{Path: p})
			continue
		}
		files, total, exact, err := measureFolder(workdir, p, run)
		if err != nil {
			return nil, err
		}
		if len(files) <= foldFilesOver && total <= foldBytesOver && exact {
			for _, f := range files {
				items = append(items, untrackedItem{Path: f})
			}
			continue
		}
		items = append(items, untrackedItem{Path: p, Folded: true, Files: len(files), Bytes: total, BytesExact: exact})
	}
	return items, nil
}

// measureFolder lists the untracked files in the folder dir (a path ending in "/"; a name, never a pattern), their number and their size. A link is not followed for its size. exact is false when more than
// foldStatMax files were seen: the count is still exact, the size is "at least".
func measureFolder(workdir, dir string, run func(args ...string) ([]byte, error)) (files []string, total int64, exact bool, err error) {
	inside, err := run("--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", dir)
	if err != nil {
		return nil, 0, false, err
	}
	for _, f := range bytes.Split(inside, []byte{0}) {
		if len(f) > 0 {
			files = append(files, string(f))
		}
	}
	exact = true
	for i, f := range files {
		if i >= foldStatMax {
			exact = false
			break
		}
		if fi, lerr := os.Lstat(filepath.Join(workdir, f)); lerr == nil && fi.Mode().IsRegular() { // a link is never followed
			total += fi.Size()
		}
	}
	return files, total, exact, nil
}
