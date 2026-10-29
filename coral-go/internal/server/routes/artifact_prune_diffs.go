package routes

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type diffCandidate struct {
	kind     string // "task" or "session"
	id       string
	path     string
	board    string
	boardKey string // a task diff's board folder ("" for the older layout, by id alone)
	bytes    int64
	links    uint64
	inode    fileKey
	at       time.Time // when it was closed: the task's completed_at, the session's stopped_at
}

// taskDiffDir is one task's folder of stored diffs: its id, where it is, and the board key it is kept under ("" for the older layout, by id alone, which nothing serves any more but the prune still ages out).
type taskDiffDir struct {
	id, path, boardKey string
}

// taskDiffDirs lists the task folders under artifacts/tasks: <board key>/<id> (#6948) and the older <id> folders.
func taskDiffDirs(taskDir string) []taskDiffDir {
	var out []taskDiffDir
	entries, err := os.ReadDir(taskDir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := strconv.ParseInt(e.Name(), 10, 64); err == nil {
			out = append(out, taskDiffDir{id: e.Name(), path: filepath.Join(taskDir, e.Name())})
			continue
		}
		inner, err := os.ReadDir(filepath.Join(taskDir, e.Name()))
		if err != nil {
			continue
		}
		for _, i := range inner {
			if i.IsDir() {
				out = append(out, taskDiffDir{id: i.Name(), path: filepath.Join(taskDir, e.Name(), i.Name()), boardKey: e.Name()})
			}
		}
	}
	return out
}

// closedDiffs lists the stored task and session diffs whose task is completed or skipped, or
// whose session is stopped; olderThan 0 lists all of them (shrink).
func (h *SessionsHandler) closedDiffs(ctx context.Context, o pruneOptions) ([]diffCandidate, error) {
	coralDir := h.cfg.CoralDir()
	var out []diffCandidate

	type taskRow struct {
		ID          int64   `db:"id"`
		Status      string  `db:"status"`
		BoardID     string  `db:"board_id"`
		CompletedAt *string `db:"completed_at"`
	}
	tasks := map[string]taskRow{}
	if h.bs != nil {
		var rows []taskRow
		if err := h.bs.Reader().SelectContext(ctx, &rows, "SELECT id, status, board_id, completed_at FROM board_tasks"); err != nil {
			return nil, err
		}
		for _, t := range rows {
			tasks[strconv.FormatInt(t.ID, 10)] = t
		}
	}
	taskDir := filepath.Join(coralDir, "artifacts", "tasks")
	for _, d := range taskDiffDirs(taskDir) {
		t, known := tasks[d.id]
		if known && d.boardKey != "" && TaskBoardKey(t.BoardID) != d.boardKey {
			t, known = taskRow{}, false // another board's task of the same id (ids start again after a restore): not this one's
		}
		if known && t.Status != "completed" && t.Status != "skipped" {
			continue // an open task: its diff may still change
		}
		c, ok := diffAt(filepath.Join(d.path, "changes.diff"))
		if !ok {
			continue
		}
		c.kind, c.id, c.board, c.boardKey = "task", d.id, t.BoardID, d.boardKey
		if known {
			// Aged by when the task was closed (a shared diff's file time is when it was first
			// stored). No readable completed_at: too young to judge, so it stays.
			at, ok := closedAt(t.CompletedAt)
			if !ok {
				continue
			}
			c.at = at
		}
		if o.Now.Sub(c.at) >= o.OlderThan {
			out = append(out, c)
		}
	}

	type sessRow struct {
		SessionID string  `db:"session_id"`
		Status    *string `db:"status"`
		Sleeping  int     `db:"is_sleeping"`
		StoppedAt *string `db:"stopped_at"`
		Board     *string `db:"board_name"`
	}
	sessions := map[string]sessRow{}
	if h.db != nil {
		var rows []sessRow
		if err := h.db.Reader().SelectContext(ctx, &rows, "SELECT session_id, status, is_sleeping, stopped_at, board_name FROM live_sessions"); err != nil {
			return nil, err
		}
		for _, s := range rows {
			sessions[s.SessionID] = s
		}
	}
	sessDir := filepath.Join(coralDir, "artifacts", "sessions")
	if entries, err := os.ReadDir(sessDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			s, known := sessions[e.Name()]
			if known && (s.Sleeping != 0 || s.Status == nil || *s.Status != "inactive") {
				continue // running or sleeping: it can be resumed
			}
			c, ok := diffAt(filepath.Join(sessDir, e.Name(), "changes.diff"))
			if !ok {
				continue
			}
			c.kind, c.id = "session", e.Name()
			if known && s.Board != nil {
				c.board = *s.Board
			}
			if known {
				at, ok := closedAt(s.StoppedAt)
				if !ok {
					continue // no readable stopped_at: too young to judge
				}
				c.at = at
			}
			if o.Now.Sub(c.at) >= o.OlderThan {
				out = append(out, c)
			}
		}
	}
	return out, nil
}

func closedAt(s *string) (time.Time, bool) {
	if s == nil || strings.TrimSpace(*s) == "" {
		return time.Time{}, false
	}
	at, err := parseDBTime(*s)
	return at, err == nil
}

func diffAt(path string) (diffCandidate, bool) {
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return diffCandidate{}, false
	}
	return diffCandidate{path: path, bytes: fi.Size(), links: fileLinks(path, fi), inode: identityOf(path, fi), at: fi.ModTime()}, true
}

// fileKey identifies a stored file across its hard links: (device, inode), or its path where
// the system gives no identity (each file is then its own).
type fileKey = string

func identityOf(path string, fi os.FileInfo) fileKey {
	if key, ok := fileIdentity(path, fi); ok {
		return key
	}
	return "path:" + path
}

// diffObjectInodes: the inodes of artifacts/diff-objects, so a diff removal knows whether its
// bytes stay behind in a shared object (freed only once the sweep removes it).
func diffObjectInodes(coralDir string) map[fileKey]bool {
	out := map[fileKey]bool{}
	entries, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "diff-objects"))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if fi, err := e.Info(); err == nil && fi.Mode().IsRegular() {
			out[identityOf(filepath.Join(coralDir, "artifacts", "diff-objects", e.Name()), fi)] = true
		}
	}
	return out
}

// pruneDiffs removes closed diffs (their links). Bytes count as freed only when no other diff
// and no shared object keeps them; a shared object's bytes are freed by the sweep.
func (h *SessionsHandler) pruneDiffs(ctx context.Context, o pruneOptions, diffs []diffCandidate, rep *pruneReport, capped func() bool) {
	objects := diffObjectInodes(h.cfg.CoralDir())
	candidateLinks := map[fileKey]uint64{}
	for _, d := range diffs {
		candidateLinks[d.inode]++
	}
	counted := map[fileKey]bool{}
	for _, d := range diffs {
		if capped() {
			return
		}
		it := pruneItem{Kind: pruneKindDiffs, ID: d.kind + " " + d.id, Board: d.board, Bytes: d.bytes, AgeDays: o.Now.Sub(d.at).Hours() / 24}
		// Freed: the inode goes once every link to it is a candidate (plus its diff object,
		// which the sweep removes).
		// Signed, clamped: a link added or removed since the listing must not wrap (Lead's NIT D).
		others := int64(d.links) - int64(candidateLinks[d.inode])
		if objects[d.inode] {
			others--
		}
		if others < 0 {
			others = 0
		}
		freedHere := int64(0)
		if others == 0 && !counted[d.inode] {
			freedHere = d.bytes
			counted[d.inode] = true
		}
		if o.DryRun {
			rep.add(it)
			rep.Freed += freedHere
			continue
		}
		if pruneBeforeDiffHook != nil {
			pruneBeforeDiffHook(d)
		}
		if !h.diffStillClosed(ctx, d, o) {
			rep.Skipped++
			continue
		}
		if err := os.Remove(d.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			rep.Errors++
			continue
		}
		_ = os.Remove(filepath.Dir(d.path)) // the task's or session's folder, if now empty
		rep.add(it)
		rep.Removed++
		if !objects[d.inode] {
			rep.Freed += freedHere // a plain copy: freed now (a linked one, at the sweep)
		}
		slog.Info("[artifacts] pruned a stored diff", "kind", d.kind, "id", d.id, "bytes", d.bytes)
	}
}

// diffStillClosed re-checks a diff right before it goes: its task is still completed or
// skipped (a reopened task keeps its diff), its session still stopped.
func (h *SessionsHandler) diffStillClosed(ctx context.Context, d diffCandidate, o pruneOptions) bool {
	oldEnough := func(at *string) bool {
		t, ok := closedAt(at)
		return ok && o.Now.Sub(t) >= o.OlderThan
	}
	switch d.kind {
	case "task":
		if h.bs == nil {
			return false
		}
		var t struct {
			Status      string  `db:"status"`
			BoardID     string  `db:"board_id"`
			CompletedAt *string `db:"completed_at"`
		}
		err := h.bs.Reader().GetContext(ctx, &t, "SELECT status, board_id, completed_at FROM board_tasks WHERE id = ?", d.id)
		if errors.Is(err, sqlNoRows) {
			return true // the task is gone
		}
		if err == nil && d.boardKey != "" && TaskBoardKey(t.BoardID) != d.boardKey {
			return true // another board's task of this id (ids start again after a restore): this diff's task is gone (#6948)
		}
		// Still closed AND still old: a task reopened and closed again since the listing has a
		// new diff, which isn't due yet (Security's #3554 review).
		return err == nil && (t.Status == "completed" || t.Status == "skipped") && oldEnough(t.CompletedAt)
	case "session":
		var s struct {
			Status    *string `db:"status"`
			Sleeping  int     `db:"is_sleeping"`
			StoppedAt *string `db:"stopped_at"`
		}
		err := h.db.Reader().GetContext(ctx, &s, "SELECT status, is_sleeping, stopped_at FROM live_sessions WHERE session_id = ?", d.id)
		if errors.Is(err, sqlNoRows) {
			return true
		}
		return err == nil && s.Sleeping == 0 && s.Status != nil && *s.Status == "inactive" && oldEnough(s.StoppedAt)
	}
	return false
}

// shrinkDiffs rewrites each closed diff through #3555's filter (the text changes stay; secrets,
// dot-files, binaries and oversized sections become one-line notes). The new content is a new
// diff object and the diff is relinked to it; a shared object is never edited in place.
func (h *SessionsHandler) shrinkDiffs(ctx context.Context, o pruneOptions, diffs []diffCandidate, rep *pruneReport) {
	done := map[fileKey]bool{}
	// The old bytes are freed only when every link to them is rewritten (Lead's NIT E): a diff
	// shared with an open task, which isn't shrunk, keeps them on disk.
	objects := diffObjectInodes(h.cfg.CoralDir())
	candidateLinks := map[fileKey]int64{}
	for _, d := range diffs {
		candidateLinks[d.inode]++
	}
	allLinksShrunk := func(d diffCandidate) bool {
		others := int64(d.links) - candidateLinks[d.inode]
		if objects[d.inode] {
			others--
		}
		return others <= 0
	}
	for _, d := range diffs {
		if o.MaxBytes > 0 && rep.Freed >= o.MaxBytes {
			rep.Capped = true // retention's per-run cap, as the other kinds stop at it
			break
		}
		if d.bytes > pruneDiffReadLimit {
			rep.Errors++
			continue
		}
		data, err := os.ReadFile(d.path)
		if err != nil {
			rep.Errors++
			continue
		}
		small := safeDiff(data)
		if len(small) >= len(data) {
			continue // nothing to drop
		}
		if !bytes.Equal(safeDiff(small), small) {
			rep.Errors++ // the result must itself be a clean, filtered patch
			continue
		}
		saved := int64(len(data) - len(small))
		it := pruneItem{Kind: "shrink", ID: d.kind + " " + d.id, Board: d.board, Bytes: saved, AgeDays: o.Now.Sub(d.at).Hours() / 24}
		freedHere := int64(0)
		if !done[d.inode] && allLinksShrunk(d) {
			freedHere = saved
			done[d.inode] = true
		}
		if o.DryRun {
			rep.add(it)
			rep.Freed += freedHere
			continue
		}
		if pruneBeforeDiffHook != nil {
			pruneBeforeDiffHook(d)
		}
		if !h.diffStillClosed(ctx, d, o) {
			rep.Skipped++
			continue
		}
		if err := writeChangesArtifact(d.path, small); err != nil {
			rep.Errors++
			continue
		}
		rep.add(it)
		rep.Removed++
		rep.Freed += freedHere
		slog.Info("[artifacts] shrank a stored diff", "kind", d.kind, "id", d.id, "from", len(data), "to", len(small))
	}
}

// sweepDiffObjects removes the shared diff objects no diff links any more (link count 1: only
// the object's own name), older than an hour so one just written for a link isn't taken.
func (h *SessionsHandler) sweepDiffObjects(o pruneOptions, rep *pruneReport, capped func() bool) {
	dir := filepath.Join(h.cfg.CoralDir(), "artifacts", "diff-objects")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if capped() {
			return
		}
		if !objectNameRe.MatchString(e.Name()) || !e.Type().IsRegular() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if fileLinks(filepath.Join(dir, e.Name()), fi) != 1 || o.Now.Sub(fi.ModTime()) < diffObjectGrace {
			continue
		}
		it := pruneItem{Kind: pruneKindDiffObjects, ID: e.Name(), Bytes: fi.Size(), AgeDays: o.Now.Sub(fi.ModTime()).Hours() / 24}
		if o.DryRun {
			rep.add(it)
			rep.Freed += fi.Size()
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			rep.Errors++
			continue
		}
		rep.add(it)
		rep.Removed++
		rep.Freed += fi.Size()
		slog.Info("[artifacts] removed an unused diff object", "digest", e.Name(), "bytes", fi.Size())
	}
}
