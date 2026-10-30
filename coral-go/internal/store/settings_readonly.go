package store

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ReadSettingsReadOnly reads the user settings from the sessions database at dbPath without opening it as the server does: read-only, nothing created, no schema step, no
// migration and no write. For a command-line tool that is not the server (launch-coral) and only needs what the person saved, such as Settings > CLI paths. A database that
// does not exist yet has no settings: (nil, nil). A database that is there but cannot be read (encrypted, locked, damaged) is an error; the caller decides what to do.
func ReadSettingsReadOnly(ctx context.Context, dbPath string) (map[string]string, error) {
	if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(dbPath)
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(abs), "/"), RawQuery: "mode=ro&_pragma=busy_timeout(5000)"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, "SELECT key, value FROM user_settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
