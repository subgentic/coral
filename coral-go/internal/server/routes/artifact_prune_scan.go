package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// artifactRefRe finds an artifact id in any text: coral://artifacts/<hex>, /api/artifacts/<hex>
// (with or without ?v=2), inside Markdown, code or angle brackets alike.
var artifactRefRe = regexp.MustCompile(`(?i)(?:coral://artifacts/|/api/artifacts/)([0-9a-f]{64})`)

// The reference scan reads EVERY column of every table in both databases, whatever its declared
// type (deny by default, Lead's and the Orchestrator's #3554 reviews: SQLite types are only
// declarations, so a BLOB or INTEGER column can hold text too). A table or column added later is
// scanned without anyone remembering to list it. A table is skipped only when it is listed here,
// with the reason.
var referenceExclusions = map[string]string{
	"call_metrics":        "a request log: a GET of /api/artifacts/<hex> there is a fetch, not a link (and it is by far the slowest table to scan)",
	"call_metrics_hourly": "call_metrics rolled up by hour (#4098): route patterns and counts, never a link",
	"session_fts_data":    "session_fts's own index storage (binary); session_fts itself is scanned",
	"session_fts_idx":     "session_fts's own index storage; session_fts itself is scanned",
	"session_fts_content": "the same transcript text as session_fts, which is scanned",
	"session_fts_docsize": "session_fts's own index storage (sizes)",
	"session_fts_config":  "session_fts's own settings",
}

// scanArtifactReferences returns every artifact id something durable links. Any error fails the
// whole scan: a prune must never delete "what it could verify".
func (h *SessionsHandler) scanArtifactReferences(ctx context.Context) (map[string]bool, error) {
	if h.bs == nil || h.db == nil {
		return nil, errors.New("the board or session database isn't available")
	}
	ctx, cancel := context.WithTimeout(ctx, pruneScanTimeout)
	defer cancel()
	refs := map[string]bool{}
	if err := scanAllColumns(ctx, h.bs.Reader(), refs); err != nil {
		return nil, fmt.Errorf("board database: %w", err)
	}
	if err := scanAllColumns(ctx, h.db.Reader(), refs); err != nil {
		return nil, fmt.Errorf("session database: %w", err)
	}
	if err := scanKnowledgeReferences(ctx, filepath.Join(h.cfg.CoralDir(), "agent_knowledge"), refs); err != nil {
		return nil, fmt.Errorf("knowledge files: %w", err)
	}
	if err := scanCrossTeamRecordRefs(h.cfg.CoralDir(), refs); err != nil {
		return nil, fmt.Errorf("shared and received rows: %w", err)
	}
	return refs, nil
}

// scannedColumns lists, per table, the columns the scan reads in db (all of them).
func scannedColumns(ctx context.Context, db *sqlx.DB) (map[string][]string, error) {
	var tables []string
	if err := db.SelectContext(ctx, &tables, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, t := range tables {
		if _, skip := referenceExclusions[t]; skip {
			continue
		}
		rows, err := db.QueryxContext(ctx, "SELECT name FROM pragma_table_info(?)", t)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return nil, err
			}
			out[t] = append(out[t], name)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// scanAllColumns reads every column of every table (one query per table) for links.
func scanAllColumns(ctx context.Context, db *sqlx.DB, refs map[string]bool) error {
	cols, err := scannedColumns(ctx, db)
	if err != nil {
		return err
	}
	for table, names := range cols {
		sel := make([]string, len(names))
		where := make([]string, len(names))
		for i, n := range names {
			sel[i] = "CAST(" + quoteIdent(n) + " AS BLOB)"
			where[i] = quoteIdent(n) + " LIKE '%artifacts/%'"
		}
		// Names come from this database's own schema, quoted; never from a request.
		rows, err := db.QueryContext(ctx, "SELECT "+strings.Join(sel, ", ")+" FROM "+quoteIdent(table)+" WHERE "+strings.Join(where, " OR "))
		if err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
		vals := make([][]byte, len(names))
		ptrs := make([]any, len(names))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		for rows.Next() {
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				return fmt.Errorf("%s: %w", table, err)
			}
			for _, v := range vals {
				addArtifactRefs(v, refs)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
	}
	return nil
}

func addArtifactRefs(text []byte, refs map[string]bool) {
	for _, m := range artifactRefRe.FindAllSubmatch(text, -1) {
		refs[strings.ToLower(string(m[1]))] = true
	}
}

// addArtifactRefsFrom scans a reader in chunks, keeping an overlap longer than any link so one
// split across two chunks is still found (Security's #3554 review: a big file must not be skipped).
func addArtifactRefsFrom(ctx context.Context, r io.Reader, refs map[string]bool) error {
	const chunk, overlap = 1 << 20, 128
	buf := make([]byte, 0, chunk+overlap)
	tmp := make([]byte, chunk)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, err := r.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if len(buf) > overlap || err != nil {
			addArtifactRefs(buf, refs)
			if len(buf) > overlap {
				buf = append(buf[:0], buf[len(buf)-overlap:]...)
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func scanKnowledgeReferences(ctx context.Context, dir string, refs map[string]bool) error {
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !d.Type().IsRegular() || !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err // unreadable: the scan can't vouch for it, so the run removes nothing
		}
		defer f.Close()
		if err := addArtifactRefsFrom(ctx, f, refs); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// scanCrossTeamRecordRefs adds every artifact a board's shared or received row lists (#4379): an
// artifact a board lists is linked, whatever its message says now.
func scanCrossTeamRecordRefs(coralDir string, refs map[string]bool) error {
	for _, kind := range crossTeamRecordKinds {
		root := filepath.Join(coralDir, "artifacts", kind)
		boards, err := os.ReadDir(root)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err // unreadable: the scan can't vouch for it, so the run removes nothing
		}
		for _, b := range boards {
			if !b.IsDir() {
				continue
			}
			entries, err := os.ReadDir(filepath.Join(root, b.Name()))
			if err != nil {
				return err
			}
			for _, e := range entries {
				if id := strings.TrimSuffix(e.Name(), ".json"); id != e.Name() && managedArtifactID("coral://artifacts/"+id) == id {
					refs[id] = true
				}
			}
		}
	}
	return nil
}

func (h *SessionsHandler) keptArtifacts(ctx context.Context) (map[string]bool, error) {
	kept := map[string]bool{}
	if h.db == nil {
		return kept, nil
	}
	var ids []string
	if err := h.db.Reader().SelectContext(ctx, &ids, "SELECT hex FROM artifact_keep"); err != nil {
		return nil, err
	}
	for _, id := range ids {
		kept[id] = true
	}
	return kept, nil
}

// protectedArtifacts is what pruning must not remove: the artifacts the Operator keeps, and every member of an artifact series (#6357, pick 4: keep all; a version goes only by the explicit
// delete). The Operator's own list of what it keeps (keptListRoute) stays only what it marked.
func (h *SessionsHandler) protectedArtifacts(ctx context.Context) (map[string]bool, error) {
	kept, err := h.keptArtifacts(ctx)
	if err != nil {
		return nil, err
	}
	for id := range seriesMemberSet(h.cfg.CoralDir()) {
		kept[id] = true
	}
	return kept, nil
}

// isProtected is isKept for a prune's re-check under the artifact's lock: kept by the Operator, or a member of a series.
func (h *SessionsHandler) isProtected(ctx context.Context, id string) (bool, error) {
	if kept, err := h.isKept(ctx, id); err != nil || kept {
		return kept, err
	}
	_, _, inSeries := digestSeries(h.cfg.CoralDir(), id)
	return inSeries, nil
}

func (h *SessionsHandler) isKept(ctx context.Context, id string) (bool, error) {
	var n int
	err := h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_keep WHERE hex = ?", id)
	return n > 0, err
}

// uploadRecordTimes: each artifact's newest upload record (uploads/<session>/<hex>.json).
func uploadRecordTimes(coralDir string) map[string]time.Time {
	out := map[string]time.Time{}
	sessions, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "uploads"))
	if err != nil {
		return out
	}
	for _, s := range sessions {
		up := uploadsDir(coralDir, s.Name())
		if up == "" || !s.IsDir() {
			continue
		}
		recs, err := os.ReadDir(up)
		if err != nil {
			continue
		}
		for _, f := range recs {
			id := strings.TrimSuffix(f.Name(), ".json")
			if !objectNameRe.MatchString(id) || !f.Type().IsRegular() {
				continue
			}
			t := recordTime(filepath.Join(up, f.Name()))
			if t.After(out[id]) {
				out[id] = t
			}
		}
	}
	return out
}

func recordTime(path string) time.Time {
	var rec struct {
		CreatedAt string `json:"created_at"`
	}
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &rec) == nil {
		if t, err := time.Parse(time.RFC3339, rec.CreatedAt); err == nil {
			return t
		}
	}
	if fi, err := os.Stat(path); err == nil {
		return fi.ModTime()
	}
	return time.Time{}
}

// objectNewestUse: an object's newest upload record, else its file time.
func objectNewestUse(coralDir, id string, records map[string]time.Time) time.Time {
	if !objectNameRe.MatchString(id) { // an id read from a file or a message is a 64-digit hex name before it is joined onto a folder (#5305)
		return time.Time{}
	}
	if t, ok := records[id]; ok {
		return t
	}
	if fi, err := os.Stat(filepath.Join(coralDir, "artifacts", "objects", id)); err == nil {
		return fi.ModTime()
	}
	return time.Time{}
}

type objectCandidate struct {
	id    string
	bytes int64
	name  string
	use   time.Time
}

func (h *SessionsHandler) objectCandidates(ctx context.Context, o pruneOptions, refs, kept map[string]bool) ([]objectCandidate, error) {
	coralDir := h.cfg.CoralDir()
	entries, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "objects"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	records := uploadRecordTimes(coralDir)
	var out []objectCandidate
	for _, e := range entries {
		id := e.Name()
		if !objectNameRe.MatchString(id) || !e.Type().IsRegular() || refs[id] || kept[id] {
			continue
		}
		use := objectNewestUse(coralDir, id, records)
		if o.Now.Sub(use) < o.OlderThan {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		name := ""
		if meta, ok := readSidecar(filepath.Join(coralDir, "artifacts", "objects", id+".json")); ok {
			name = meta.Name
		}
		out = append(out, objectCandidate{id: id, bytes: info.Size(), name: name, use: use})
	}
	return out, nil
}
