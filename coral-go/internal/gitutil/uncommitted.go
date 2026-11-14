package gitutil

import (
	"bytes"
	"context"
	"strings"
)

// maxUncommitted is how many entries one status read keeps: a folder with a node_modules that nothing ignores must not make a request without end (#17203).
const maxUncommitted = 5000

// Uncommitted is what `git status` lists in the work tree at dir: the paths changed since the last commit (modified, added, deleted, renamed, staged or not) and the new ones git does not track yet (ignored
// files are never listed). Paths are relative to the work tree's top, as git writes them. truncated says the list was cut at maxUncommitted.
func Uncommitted(ctx context.Context, dir string) (changed, added []string, truncated bool, err error) {
	out, err := Command(ctx, dir, "status", "--porcelain=v1", "-z", "--untracked-files=all").Output()
	if err != nil {
		return nil, nil, false, err
	}
	parts := bytes.Split(out, []byte{0})
	for i := 0; i < len(parts); i++ {
		entry := string(parts[i])
		if len(entry) < 4 {
			continue
		}
		code, path := entry[:2], entry[3:]
		if code[0] == 'R' || code[0] == 'C' || code[1] == 'R' || code[1] == 'C' {
			i++ // a rename or copy is followed by its old name
		}
		if len(changed)+len(added) >= maxUncommitted {
			return changed, added, true, nil
		}
		if code == "??" {
			added = append(added, path)
		} else if code != "!!" {
			changed = append(changed, path)
		}
	}
	return changed, added, false, nil
}

// TopLevel is the top of the work tree that contains dir, or "" when dir is in none.
func TopLevel(ctx context.Context, dir string) string {
	out, err := Command(ctx, dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
