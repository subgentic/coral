package board

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// These snapshots pin schema text as well as SQLite's interpretation of columns
// and indexes, separately for a fresh store and each real old-release fixture.
// Regenerate only before an intentional schema change, never during a refactor:
// UPDATE_BOARD_SCHEMA_GOLDENS=1 go test -run '^TestBoardSchemaGolden$' ./internal/board
func TestBoardSchemaGolden(t *testing.T) {
	for _, version := range []string{"fresh", "v1.4.80", "v1.4.110", "v1.4.80-pre-review"} {
		t.Run(version, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "messageboard.db")
			if version != "fresh" {
				fixtureVersion := version
				if version == "v1.4.80-pre-review" {
					fixtureVersion = "v1.4.80"
				}
				dump := filepath.Join("testdata", "migration", fixtureVersion, "messageboard.sql")
				if version == "v1.4.80-pre-review" {
					// The release dumps already allow review_pending. Remove that one
					// status to exercise the older constraint-rebuild path as well.
					script, err := os.ReadFile(dump)
					require.NoError(t, err)
					require.Equal(t, 1, strings.Count(string(script), ", 'review_pending'"))
					dump = filepath.Join(t.TempDir(), "pre-review.sql")
					require.NoError(t, os.WriteFile(dump, []byte(strings.Replace(string(script), ", 'review_pending'", "", 1)), 0600))
				}
				loadDump(t, path, dump)
				require.Equal(t, "0", scalar(t, path, "SELECT count(*) FROM pragma_table_info('board_messages') WHERE name='task_id'"), "the fixture needs an upgrade")
			}
			s, err := NewStoreWithKey(path, "")
			require.NoError(t, err)
			require.NoError(t, s.Close())
			got := boardSchemaSnapshot(t, path)
			golden := filepath.Join("testdata", "schema", version+".json")
			if os.Getenv("UPDATE_BOARD_SCHEMA_GOLDENS") == "1" {
				require.NoError(t, os.MkdirAll(filepath.Dir(golden), 0755))
				require.NoError(t, os.WriteFile(golden, got, 0644))
			}
			want, err := os.ReadFile(golden)
			require.NoError(t, err, "generate the baseline with the unmodified schema code")
			require.Equal(t, string(want), string(got), "schema changed from %s golden", version)

			// Starting the same migrated store again must not change any schema object.
			s, err = NewStoreWithKey(path, "")
			require.NoError(t, err)
			require.NoError(t, s.Close())
			require.Equal(t, string(want), string(boardSchemaSnapshot(t, path)), "second open of %s", version)
		})
	}
}

func boardSchemaSnapshot(t *testing.T, path string) []byte {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	require.NoError(t, err)
	defer db.Close()
	type tableShape struct {
		Columns []map[string]any `json:"columns"`
		Indexes []map[string]any `json:"indexes"`
	}
	shape := struct {
		Objects []map[string]any      `json:"sqlite_master"`
		Tables  map[string]tableShape `json:"tables"`
	}{
		Objects: boardSchemaRows(t, db, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"),
		Tables:  map[string]tableShape{},
	}
	for _, object := range shape.Objects {
		if object["type"] != "table" {
			continue
		}
		name := object["name"].(string)
		indexes := boardSchemaRows(t, db, "SELECT * FROM pragma_index_list(?) ORDER BY name", name)
		for _, index := range indexes {
			index["columns"] = boardSchemaRows(t, db, "SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno", index["name"])
		}
		shape.Tables[name] = tableShape{
			Columns: boardSchemaRows(t, db, "SELECT * FROM pragma_table_xinfo(?) ORDER BY cid", name),
			Indexes: indexes,
		}
	}
	out, err := json.MarshalIndent(shape, "", "  ")
	require.NoError(t, err)
	return append(out, '\n')
}

func boardSchemaRows(t *testing.T, db *sql.DB, query string, args ...any) []map[string]any {
	t.Helper()
	rows, err := db.Query(query, args...)
	require.NoError(t, err)
	defer rows.Close()
	cols, err := rows.Columns()
	require.NoError(t, err)
	out := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(cols))
		pointers := make([]any, len(cols))
		for i := range values {
			pointers[i] = &values[i]
		}
		require.NoError(t, rows.Scan(pointers...))
		record := map[string]any{}
		for i, name := range cols {
			value := values[i]
			if text, ok := value.([]byte); ok {
				value = string(text)
			}
			record[name] = value
		}
		out = append(out, record)
	}
	require.NoError(t, rows.Err())
	return out
}
