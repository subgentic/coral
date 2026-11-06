package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ── User Settings ──────────────────────────────────────────────────────

// GetSettings returns all user settings as a map.
func (s *SessionStore) GetSettings(ctx context.Context) (map[string]string, error) {
	var settings []UserSetting
	if err := s.reader().SelectContext(ctx, &settings, "SELECT key, value FROM user_settings"); err != nil {
		return nil, err
	}
	result := make(map[string]string, len(settings))
	for _, s := range settings {
		result[s.Key] = s.Value
	}
	return result, nil
}

// settingsForCLITimeout bounds GetSettingsForCLI.
const settingsForCLITimeout = 10 * time.Second

// GetSettingsForCLI is GetSettings for a caller that is about to run an agent CLI and must not
// fall back to the one on PATH when the read fails (#4350): it reads with a context the caller's
// cancellation cannot end (a client that hangs up in the middle of a team launch), bounded by
// settingsForCLITimeout so a stuck database cannot hold the launch for ever. A caller treats an
// error as "do not run anything".
func (s *SessionStore) GetSettingsForCLI(ctx context.Context) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), settingsForCLITimeout)
	defer cancel()
	return s.GetSettings(ctx)
}

// SetSetting upserts a user setting.
func (s *SessionStore) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value)
	return err
}

// DeleteSetting deletes a user setting. Returns true if the key existed.
func (s *SessionStore) DeleteSetting(ctx context.Context, key string) (bool, error) {
	res, err := s.db.ExecContext(ctx, "DELETE FROM user_settings WHERE key = ?", key)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// settingsWriteMu serialises the writers of user_settings that read before they write: EditSettingList (a list kept as JSON text) and SaveSettings (the PUT /api/settings writer, which replaces whole values).
// Without it a dashboard's PUT of the same list could land between an edit's read and its write and be lost (#13834, Security's SHOULD).
var settingsWriteMu sync.Mutex

// SaveSettings writes a request's settings together in one transaction (#3547), under the same lock as EditSettingList.
func (s *SessionStore) SaveSettings(ctx context.Context, values map[string]string) error {
	settingsWriteMu.Lock()
	defer settingsWriteMu.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, v := range values {
		if _, err := tx.ExecContext(ctx, "INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// EditSettingList reads the setting key as a JSON array of strings (anything else is an empty list), lets edit change it, keeps the newest max entries (the oldest go first) and writes it back, all under
// the settings write lock and in one transaction: two edits, or an edit and a PUT, cannot lose each other. It returns the list as written.
func (s *SessionStore) EditSettingList(ctx context.Context, key string, max int, edit func([]string) []string) ([]string, error) {
	settingsWriteMu.Lock()
	defer settingsWriteMu.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var raw string
	if err := tx.GetContext(ctx, &raw, "SELECT value FROM user_settings WHERE key = ?", key); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var list []string
	if json.Unmarshal([]byte(raw), &list) != nil {
		list = nil
	}
	list = edit(list)
	if max > 0 && len(list) > max {
		list = list[len(list)-max:]
	}
	if list == nil {
		list = []string{}
	}
	b, _ := json.Marshal(list)
	if _, err := tx.ExecContext(ctx, "INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, string(b)); err != nil {
		return nil, err
	}
	return list, tx.Commit()
}
