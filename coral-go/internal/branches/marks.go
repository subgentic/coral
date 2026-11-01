package branches

import (
	"bytes"
	"context"
	"strconv"
	"strings"
	"time"
)

// The marks of a worktree's branch (the second part of goal #11's tab): its upstream branch is deleted, or it has had no commit for quietAfter. Labels only, worded as what is so
// (Security's SHOULD 8 on #6802): nothing here suggests deleting anything. Read with one for-each-ref over refs/heads, in a fixed format; branch names are matched as text, never given to git.

const quietAfter = 14 * 24 * time.Hour

// refsFormat is the one format for-each-ref is run with: the ref's full name, its upstream tracking ("[gone]" when the upstream branch was deleted) and its last commit's time.
const refsFormat = "--format=%(refname)%00%(upstream:track)%00%(committerdate:unix)"

// refInfo is one local branch's marks.
type refInfo struct {
	gone      bool
	committed time.Time
}

// refs reads the marks of every local branch of the repository at root, by the branch's name as git lists it.
func (c *Collector) refs(ctx context.Context, root string) map[string]refInfo {
	out, err := c.run(ctx, root, "for-each-ref", refsFormat, "refs/heads")
	if err != nil {
		return nil
	}
	return parseRefs(out)
}

// parseRefs reads for-each-ref's output in refsFormat: one line per branch, its fields NUL-separated.
func parseRefs(out []byte) map[string]refInfo {
	m := map[string]refInfo{}
	for _, line := range bytes.Split(out, []byte{'\n'}) {
		f := bytes.Split(line, []byte{0})
		if len(f) != 3 || !bytes.HasPrefix(f[0], []byte("refs/heads/")) {
			continue
		}
		name := strings.TrimPrefix(string(f[0]), "refs/heads/")
		info := refInfo{gone: strings.Contains(string(f[1]), "gone")}
		if sec, err := strconv.ParseInt(strings.TrimSpace(string(f[2])), 10, 64); err == nil && sec > 0 {
			info.committed = time.Unix(sec, 0)
		}
		m[name] = info
	}
	return m
}

// mark sets w's marks from the branch's refInfo (a worktree whose name is not shown, or detached, gets none).
func mark(w *Worktree, refs map[string]refInfo, now time.Time) {
	if w.Branch == "" || refs == nil {
		return
	}
	info, ok := refs[w.Branch]
	if !ok {
		return
	}
	w.UpstreamGone = info.gone
	w.Quiet = !info.committed.IsZero() && now.Sub(info.committed) >= quietAfter
}
