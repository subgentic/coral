package gitutil

import (
	"bytes"
	"context"
	"sort"
	"strings"
)

// numstatArgBytes is how much of the names go on one git command line (Windows allows 32 KB in all).
var numstatArgBytes = 20 << 10

// numstatBatchHook runs once per batch of names, with how many it holds (a test counts the batches).
var numstatBatchHook = func(names int) {}

// CappedNumstat is `git diff <refs> --numstat` (with -z when z) for a list that is cut to its first limit files by name, and how many more files than that changed (#13155).
//
// A big working tree made the numstat the whole cost of a refresh: git reads and diffs every changed file for its line counts, 1.3 to 3 s for 35,000 changed files, to fill a list that is cut to limit rows anyway. The
// names alone cost a tenth of that (no content is read). So the names come first; a diff of no more than limit files is numbered as it always was (renames included), and a bigger one is numbered for its first limit
// names only, in batches that fit a command line and with the names taken literally (no glob), without rename detection (a renamed file is its new name). more is the number of changed files not in out. If git cannot do
// the limited run, the plain numstat is the answer.
func CappedNumstat(ctx context.Context, workdir string, refs []string, limit int, z bool) (out []byte, more int, err error) {
	plain := func() ([]byte, error) {
		args := append(append([]string{"diff"}, refs...), "--numstat")
		if z {
			args = append(args, "-z")
		}
		return Command(ctx, workdir, args...).Output()
	}
	if limit <= 0 {
		out, err = plain()
		return out, 0, err
	}
	names, nerr := Command(ctx, workdir, append(append([]string{"diff"}, refs...), "--name-only", "--no-renames", "-z")...).Output()
	if nerr != nil {
		out, err = plain() // the same failure, said by the same command as before
		return out, 0, err
	}
	var paths []string
	for _, n := range bytes.Split(names, []byte{0}) {
		if len(n) > 0 {
			paths = append(paths, string(n))
		}
	}
	total := len(paths)
	if total <= limit {
		out, err = plain()
		return out, 0, err
	}
	sort.Strings(paths) // git lists a diff in this order; the cut is by name, as the list is
	paths = pathspecsFor(paths, limit)
	var all bytes.Buffer
	for len(paths) > 0 {
		n, size := 0, 0
		for n < len(paths) && size < numstatArgBytes {
			size += len(paths[n]) + 1
			n++
		}
		numstatBatchHook(n)
		args := append(append([]string{"diff"}, refs...), "--numstat", "--no-renames")
		if z {
			args = append(args, "-z")
		}
		args = append(append(args, "--"), paths[:n]...)
		cmd := Command(ctx, workdir, args...)
		cmd.Env = append(cmd.Env, "GIT_LITERAL_PATHSPECS=1") // a name is a name, never a glob
		part, perr := cmd.Output()
		if perr != nil {
			if ctx.Err() != nil {
				return nil, 0, perr
			}
			out, err = plain()
			return out, 0, err
		}
		all.Write(part)
		paths = paths[n:]
	}
	return all.Bytes(), total - limit, nil
}

// pathspecsFor names the first limit of the sorted paths for a diff, in as few pathspecs as it can: git matches every pathspec against every changed file, so two thousand file names cost more than the diff of them.
// The paths under one folder are together in the sorted list, so a folder none of whose paths comes after the cut is named whole; only the folders the cut runs through (and files at the top) are named by file.
func pathspecsFor(sorted []string, limit int) []string {
	cut := sorted[limit] // the first path left out
	seen := map[string]bool{}
	var specs []string
	for _, p := range sorted[:limit] {
		spec := p
		for i := 0; i < len(p); i++ { // the highest folder of p the cut does not run through
			if p[i] == '/' {
				dir := p[:i]
				if !strings.HasPrefix(cut, dir+"/") {
					spec = dir
					break
				}
			}
		}
		if !seen[spec] {
			seen[spec] = true
			specs = append(specs, spec)
		}
	}
	return specs
}
