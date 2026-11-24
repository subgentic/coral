package reviewsize

import (
	"bytes"
	"strconv"
	"strings"
)

// ParseDiff reads the per-file counts out of a unified diff (a task's changes.diff): the path on the new side (a deleted file's old path), the added and deleted lines, and whether the file is binary.
// It reads the hunks by their own line counts, so a changed line that itself starts with "++" or "--" is counted, and the "---" and "+++" file headers are not. A text that is no diff gives no files.
func ParseDiff(b []byte) []File {
	var out []File
	var cur *File
	oldLeft, newLeft := 0, 0 // lines of the current hunk still to be read
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, line := range bytes.Split(b, []byte("\n")) {
		s := string(line)
		if oldLeft > 0 || newLeft > 0 {
			switch {
			case strings.HasPrefix(s, "+"):
				cur.Added++
				newLeft--
				continue
			case strings.HasPrefix(s, "-"):
				cur.Deleted++
				oldLeft--
				continue
			case strings.HasPrefix(s, " "), s == "":
				oldLeft--
				newLeft--
				continue
			case strings.HasPrefix(s, `\`):
				continue // "\ No newline at end of file"
			}
			oldLeft, newLeft = 0, 0 // a short hunk: leave it and read the line as a header
		}
		switch {
		case strings.HasPrefix(s, "diff --git "):
			flush()
			cur = &File{Path: pathOfHeader(strings.TrimPrefix(s, "diff --git "))}
		case cur == nil:
		case strings.HasPrefix(s, "Binary files "), strings.HasPrefix(s, "GIT binary patch"):
			cur.Binary = true
		case strings.HasPrefix(s, "@@ "):
			oldLeft, newLeft = hunkCounts(s)
		}
	}
	flush()
	return out
}

// hunkCounts reads "@@ -a,b +c,d @@" and gives b and d (1 when a count is left out).
func hunkCounts(s string) (oldN, newN int) {
	fields := strings.Fields(s)
	if len(fields) < 3 {
		return 0, 0
	}
	return rangeLen(fields[1]), rangeLen(fields[2])
}

func rangeLen(f string) int {
	f = strings.TrimLeft(f, "+-")
	if i := strings.IndexByte(f, ','); i >= 0 {
		n, err := strconv.Atoi(f[i+1:])
		if err != nil || n < 0 {
			return 0
		}
		return n
	}
	return 1
}

// pathOfHeader is the new side of "a/x b/y" (both sides may be quoted with C escapes, as git writes a path with unusual bytes).
func pathOfHeader(h string) string {
	if strings.HasPrefix(h, `"`) {
		if end := closingQuote(h); end > 0 {
			rest := strings.TrimSpace(h[end+1:])
			if strings.HasPrefix(rest, `"`) {
				return stripSide(unquote(rest))
			}
			return stripSide(rest)
		}
	}
	// Unquoted: "a/x b/y". The new side starts at the last " b/" (a path with that inside is the rare case, and then only the count's label is off).
	if i := strings.LastIndex(h, " b/"); i >= 0 {
		return h[i+3:]
	}
	return h
}

func closingQuote(h string) int {
	for i := 1; i < len(h); i++ {
		if h[i] == '\\' {
			i++
		} else if h[i] == '"' {
			return i
		}
	}
	return -1
}

func unquote(q string) string {
	if end := closingQuote(q); end > 0 {
		if s, err := strconv.Unquote(q[:end+1]); err == nil {
			return s
		}
		return q[1:end]
	}
	return q
}

func stripSide(p string) string {
	if len(p) > 2 && (p[0] == 'a' || p[0] == 'b') && p[1] == '/' {
		return p[2:]
	}
	return p
}
