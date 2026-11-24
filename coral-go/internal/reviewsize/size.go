// Package reviewsize is the review size guard's counting (#21022, brief task 3, Warn mode): how many lines and files a change touches once the
// paths the owner chose to skip are left out, and whether that is over the limits. It only counts; a warning is all that follows, never a block.
package reviewsize

import "strings"

// File is one changed file, as `git diff --numstat` reports it. Binary files have no line counts and count as files only.
type File struct {
	Path           string
	Added, Deleted int
	Binary         bool
}

// Limits are the owner's numbers. A zero limit is off for that dimension; no limits at all is never over. Skip is a list of path patterns that are not counted.
type Limits struct {
	Lines, Files int
	Skip         []string
}

// Result is the count after the skipped paths are left out, with what was left out.
type Result struct {
	Over         bool
	Lines, Files int
	SkippedLines int
	SkippedFiles int
}

// MaxSkip caps a skip list.
const MaxSkip = 50

// Check counts the files that no skip pattern matches. Lines are added plus deleted. At a limit is not over it.
func Check(files []File, l Limits) Result {
	var r Result
	for _, f := range files {
		n := f.Added + f.Deleted
		if skipped(l.Skip, f.Path) {
			r.SkippedFiles++
			r.SkippedLines += n
			continue
		}
		r.Files++
		r.Lines += n
	}
	r.Over = (l.Lines > 0 && r.Lines > l.Lines) || (l.Files > 0 && r.Files > l.Files)
	return r
}

// ParseSkip reads the comma-separated list the setting holds: trimmed, empty entries dropped, at most MaxSkip.
func ParseSkip(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
			if len(out) == MaxSkip {
				break
			}
		}
	}
	return out
}

func skipped(pats []string, path string) bool {
	for _, p := range pats {
		if matches(p, path) {
			return true
		}
	}
	return false
}

// matches reports whether pattern matches the slash path: `*` is any run of characters inside one folder, `?` one character, `**` any folders. A pattern with
// no slash matches the file's name in any folder (so "*.lock" skips yarn.lock anywhere). "dir/**" matches what is inside dir, not dir itself.
func matches(pattern, path string) bool {
	if pattern == "" {
		return false
	}
	if !strings.Contains(pattern, "/") {
		return matchSegs([]string{pattern}, []string{path[strings.LastIndex(path, "/")+1:]})
	}
	return matchSegs(strings.Split(pattern, "/"), strings.Split(path, "/"))
}

func matchSegs(pat, seg []string) bool {
	if len(pat) == 0 {
		return len(seg) == 0
	}
	if pat[0] == "**" {
		if len(pat) == 1 {
			return len(seg) > 0 // dir/** needs something inside
		}
		for i := 0; i <= len(seg); i++ {
			if matchSegs(pat[1:], seg[i:]) {
				return true
			}
		}
		return false
	}
	if len(seg) == 0 || !matchName(pat[0], seg[0]) {
		return false
	}
	return matchSegs(pat[1:], seg[1:])
}

// matchName matches one path segment against a pattern with `*` and `?`.
func matchName(p, s string) bool {
	for len(p) > 0 {
		switch p[0] {
		case '*':
			for len(p) > 0 && p[0] == '*' {
				p = p[1:]
			}
			if len(p) == 0 {
				return true
			}
			for i := 0; i <= len(s); i++ {
				if matchName(p, s[i:]) {
					return true
				}
			}
			return false
		case '?':
			if len(s) == 0 {
				return false
			}
		default:
			if len(s) == 0 || s[0] != p[0] {
				return false
			}
		}
		p, s = p[1:], s[1:]
	}
	return len(s) == 0
}
