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
	changed, added, _, truncated, err = UncommittedRenames(ctx, dir)
	return changed, added, truncated, err
}

// UncommittedRenames is Uncommitted plus the old names of renamed or copied paths: renamedFrom[newPath] = oldPath. A commit of the new path alone leaves the old name's removal staged and out of the commit (#17284), so a
// commit lists both. The old names are not in changed: a rename is one change.
func UncommittedRenames(ctx context.Context, dir string) (changed, added []string, renamedFrom map[string]string, truncated bool, err error) {
	out, err := Command(ctx, dir, "status", "--porcelain=v1", "-z", "--untracked-files=all").Output()
	if err != nil {
		return nil, nil, nil, false, err
	}
	renamedFrom = map[string]string{}
	parts := bytes.Split(out, []byte{0})
	for i := 0; i < len(parts); i++ {
		entry := string(parts[i])
		if len(entry) < 4 {
			continue
		}
		code, path := entry[:2], entry[3:]
		if code[0] == 'R' || code[0] == 'C' || code[1] == 'R' || code[1] == 'C' {
			i++ // a rename or copy is followed by its old name
			if i < len(parts) && (code[0] == 'R' || code[1] == 'R') && len(parts[i]) > 0 {
				renamedFrom[path] = string(parts[i])
			}
		}
		if len(changed)+len(added) >= maxUncommitted {
			return changed, added, renamedFrom, true, nil
		}
		if code == "??" {
			added = append(added, path)
		} else if code != "!!" {
			changed = append(changed, path)
		}
	}
	return changed, added, renamedFrom, false, nil
}

// TopLevel is the top of the work tree that contains dir, or "" when dir is in none.
func TopLevel(ctx context.Context, dir string) string {
	out, err := Command(ctx, dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
