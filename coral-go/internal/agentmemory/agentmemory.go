// Package agentmemory finds the instruction and memory files an agent's CLI reads, and reads one of them as text (#7454, the design of #7452). It reads folders, not the agent's process.
//
// Nothing here takes a path from a caller. The folders come from the agent's own working folder and git root and from the person's home folder; the file names are fixed words (CLAUDE.md, AGENTS.md ...) or,
// for a CLI's memory folder, names the folder itself lists and safefs.CheckName accepts. Every file is opened through safefs on the folder held open: never through a symlink as its last name, only a regular
// file, non-blocking.
package agentmemory

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// The kinds and levels of a file (the words the API and the page use).
const (
	KindInstructions = "instructions"
	KindMemory       = "memory"
	LevelProject     = "project"
	LevelParent      = "parent"
	LevelUser        = "user"
)

// The closed words of File.Problem: why a listed file cannot be read ("" when it can).
const (
	ProblemLink       = "link"        // a symbolic link: not followed
	ProblemNotRegular = "not_regular" // a folder, a device, a pipe
	ProblemUnreadable = "unreadable"  // anything else
)

const (
	// MaxRead is the most of a file that is read: a bigger file is cut there and says so.
	MaxRead = 256 << 10
	// MaxMemoryFiles bounds how many files of a CLI's memory folder are listed.
	MaxMemoryFiles = 100
	// maxAncestors bounds the walk up from the working folder to the git root.
	maxAncestors = 32
)

// File is one listed file. Its folder is not part of the API: a caller names a file by the id the list route issues for it.
type File struct {
	Name     string
	Kind     string
	Level    string
	Where    string // the folder, with ~ for the home folder
	Modified time.Time
	Size     int64
	Problem  string
	// LinkTo is the file a link in the folder points at ("CLAUDE.md" for an AGENTS.md that is a link to it, a path below the folder): set only for a link whose target is inside the same folder. The row then
	// shows that file's size and time, and reading it reads that file.
	LinkTo string
	dir    string // the folder, resolved
	rel    string // what is read, below dir: Name, or LinkTo for a followed link
}

// Content is a file read as text.
type Content struct {
	Text      string
	Size      int64
	Truncated bool
	Binary    bool // not text: Text is empty
}

// ErrGone is a file that is no longer there (or whose folder is).
var ErrGone = errors.New("agentmemory: the file is gone")

// instructionNames are the files a CLI reads as instructions in a project folder, in the order they are listed.
func instructionNames(agentType string) []string {
	switch agentType {
	case agenttypes.Claude:
		return []string{"CLAUDE.md", "CLAUDE.local.md"}
	case agenttypes.Codex:
		return []string{"AGENTS.md", "AGENTS.override.md"}
	case agenttypes.Gemini, agenttypes.Agy, agenttypes.Antigravity:
		return []string{"GEMINI.md", "AGENTS.md"}
	case agenttypes.Pi:
		return []string{"AGENTS.md", "CLAUDE.md"}
	}
	return []string{"AGENTS.md"}
}

// userInstructions is the folder under home and the file a CLI reads as the person's own instructions.
func userInstructions(agentType string) (dir, name string) {
	switch agentType {
	case agenttypes.Claude:
		return ".claude", "CLAUDE.md"
	case agenttypes.Codex:
		return ".codex", "AGENTS.md"
	case agenttypes.Gemini, agenttypes.Agy, agenttypes.Antigravity:
		return ".gemini", "GEMINI.md"
	case agenttypes.Pi:
		return filepath.Join(".pi", "agent"), "AGENTS.md"
	}
	return "", ""
}

// Discover lists the files agentType's CLI reads for an agent working in workdir: the project's own instruction file, those of the folders above it up to the git root (gitRoot, "" when there is none: then
// only workdir itself), the person's own file under home, then the CLI's own memory files. Nearest first. A file that is a link or not a regular file is listed with its Problem; a name that is not there is
// not listed.
func Discover(agentType, workdir, gitRoot, home string) []File {
	var out []File
	add := func(dir, name, kind, level string) {
		if f, ok := stat(dir, name, kind, level, home); ok {
			out = append(out, f)
		}
	}
	if workdir != "" {
		walked := 0
		for dir, level := workdir, LevelProject; dir != "" && walked < maxAncestors; walked++ {
			if home != "" && sameFolder(dir, home) {
				break // the home folder's own file is the user level, below
			}
			for _, n := range instructionNames(agentType) {
				add(dir, n, KindInstructions, level)
			}
			if gitRoot == "" || sameFolder(dir, gitRoot) || !within(gitRoot, dir) {
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir, level = parent, LevelParent
		}
	}
	if home != "" {
		if d, n := userInstructions(agentType); d != "" {
			add(filepath.Join(home, d), n, KindInstructions, LevelUser)
		}
		for _, dir := range memoryFolders(agentType, workdir, home) {
			out = append(out, memoryFiles(dir, home)...)
		}
	}
	return out
}

// memoryFolders are the folders of the CLI's own memory files for an agent in workdir.
func memoryFolders(agentType, workdir, home string) []string {
	switch agentType {
	case agenttypes.Claude:
		if workdir == "" {
			return nil
		}
		// Claude Code files a project's memory under the project's real path, with every link resolved, as it does its transcripts; a project reached through a link may have both.
		var dirs []string
		seen := map[string]bool{}
		hints := []string{workdir}
		if real, err := filepath.EvalSymlinks(workdir); err == nil && real != workdir {
			hints = append(hints, real)
		}
		for _, h := range hints {
			d := filepath.Join(home, ".claude", "projects", transcriptlink.ClaudeProjectDirName(h), "memory")
			if !seen[d] {
				seen[d] = true
				dirs = append(dirs, d)
			}
		}
		return dirs
	case agenttypes.Codex:
		return []string{filepath.Join(home, ".codex", "memories")}
	}
	return nil
}

// memoryFiles lists the *.md files of a memory folder: MEMORY.md first, then the others by name, at most MaxMemoryFiles.
func memoryFiles(dir, home string) []File {
	root, err := safefs.OpenRoot(dir)
	if err != nil {
		return nil
	}
	defer root.Close()
	// A memory folder is the CLI's own, under the person's home: one that resolves to somewhere else (a link made to point out of it) is not read.
	if home != "" && !within(home, root.Dir()) {
		return nil
	}
	ents, err := os.ReadDir(root.Dir())
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range ents {
		n := e.Name()
		if strings.HasSuffix(strings.ToLower(n), ".md") && safefs.CheckName(n) == nil && cleanName(n) {
			names = append(names, n)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		if a, b := names[i] == "MEMORY.md", names[j] == "MEMORY.md"; a != b {
			return a
		}
		return names[i] < names[j]
	})
	if len(names) > MaxMemoryFiles {
		names = names[:MaxMemoryFiles]
	}
	var out []File
	for _, n := range names {
		if f, ok := stat(dir, n, KindMemory, LevelProject, home); ok {
			out = append(out, f)
		}
	}
	return out
}

// cleanName reports whether a listed file name is shown as it is: valid UTF-8, no control or format character (a name is text the page prints and the API sends).
func cleanName(n string) bool {
	if !utf8.ValidString(n) {
		return false
	}
	for _, r := range n {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return true
}

// stat describes dir/name, through dir held open: false when there is no such name.
func stat(dir, name, kind, level, home string) (File, bool) {
	root, err := safefs.OpenRoot(dir)
	if err != nil {
		return File{}, false
	}
	defer root.Close()
	fi, err := root.Lstat(name)
	if err != nil {
		return File{}, false
	}
	f := File{Name: name, Kind: kind, Level: level, Where: where(root.Dir(), home), dir: root.Dir(), rel: name, Modified: fi.ModTime().UTC(), Size: fi.Size()}
	if fi.Mode()&os.ModeSymlink != 0 {
		// A link is followed only when its target resolves to a regular file inside this same folder (AGENTS.md pointing at CLAUDE.md is the usual one); a dangling link, one that leaves the folder and
		// one that points at a folder or a pipe stay listed with their problem and are never read.
		rel, ok := linkTarget(root.Dir(), name)
		if !ok {
			f.Problem = ProblemLink
			return f, true
		}
		// ...and only to a file the CLI itself would read there: an instruction name in an instruction folder, a .md file in a memory folder, never inside a dot-folder (.git) or a dot-file (.env): a link
		// planted in a cloned repository must not make the Operator read a secret on screen.
		tfi, err := root.Lstat(rel)
		if err != nil || !tfi.Mode().IsRegular() || !readableTarget(kind, rel) {
			f.Problem = ProblemLink
			return f, true
		}
		f.LinkTo, f.rel, f.Modified, f.Size = filepath.ToSlash(rel), rel, tfi.ModTime().UTC(), tfi.Size()
		return f, true
	}
	if !fi.Mode().IsRegular() {
		f.Problem = ProblemNotRegular
	}
	return f, true
}

// instructionFiles are the names any CLI reads as instructions (a link such as AGENTS.md to CLAUDE.md crosses CLIs).
var instructionFiles = map[string]bool{"CLAUDE.md": true, "CLAUDE.local.md": true, "AGENTS.md": true, "AGENTS.override.md": true, "GEMINI.md": true}

// readableTarget reports whether a followed link may lead to rel (a path below the folder): no part of it starts with a dot, and its name is an instruction file (an instruction folder) or a .md file (a
// memory folder).
func readableTarget(kind, rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == "" || strings.HasPrefix(part, ".") {
			return false
		}
	}
	base := filepath.Base(rel)
	if kind == KindMemory {
		return strings.HasSuffix(strings.ToLower(base), ".md")
	}
	return instructionFiles[base]
}

// linkTarget is where the link dir/name leads, as a path below dir, when every link on the way resolves inside dir: false for a dangling link and for one that ends outside it.
func linkTarget(dir, name string) (string, bool) {
	real, err := filepath.EvalSymlinks(filepath.Join(dir, name))
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(dir, real)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return rel, true
}

// Read reads f as text: at most MaxRead bytes (a bigger file is cut and says so), a regular file opened through its folder held open and never through a link. A file with a NUL byte or that is not UTF-8
// is Binary, with no text. The file is looked at again here, not trusted from the list.
func (f File) Read() (Content, error) {
	root, err := safefs.OpenRoot(f.dir)
	if err != nil {
		return Content{}, ErrGone
	}
	defer root.Close()
	h, fi, err := root.Open(f.rel)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Content{}, ErrGone
		}
		return Content{}, err
	}
	defer h.Close()
	data, err := io.ReadAll(io.LimitReader(h, MaxRead+1))
	if err != nil {
		return Content{}, err
	}
	c := Content{Size: fi.Size()}
	if len(data) > MaxRead {
		data, c.Truncated = data[:MaxRead], true
		for len(data) > 0 && !utf8.Valid(data) { // the cut may have split a character
			data = data[:len(data)-1]
		}
	}
	if strings.IndexByte(string(data), 0) >= 0 || !utf8.Valid(data) {
		c.Binary, c.Truncated = true, false
		return c, nil
	}
	c.Text = string(data)
	return c, nil
}

// where writes folder with ~ for the home folder.
func where(dir, home string) string {
	if home != "" {
		if real, err := safefs.Resolve(home); err == nil {
			home = real
		}
		if dir == home {
			return "~"
		}
		if rel, err := filepath.Rel(home, dir); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			return filepath.Join("~", rel)
		}
	}
	return dir
}

func sameFolder(a, b string) bool {
	ra, e1 := safefs.Resolve(a)
	rb, e2 := safefs.Resolve(b)
	if e1 != nil || e2 != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

// within reports whether dir is root or below it.
func within(root, dir string) bool {
	ra, e1 := safefs.Resolve(root)
	rb, e2 := safefs.Resolve(dir)
	if e1 != nil || e2 != nil {
		return false
	}
	rel, err := filepath.Rel(ra, rb)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
