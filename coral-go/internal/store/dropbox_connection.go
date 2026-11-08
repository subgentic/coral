package store

// This database's Dropbox sign-in (#14609, Dropbox stage 3a; design v33 §4 and §4b). The refresh token is sealed with the same master key as the other
// secrets (secretbox, AES-256-GCM, the key outside the database), bound to the Dropbox account id as AAD; it moves with a key rotation and is discarded
// by a re-key. The server id (32 random hex) belongs to the database: it is made once and kept through a disconnect, so a restored database keeps its
// Dropbox folder. The machine fingerprint (SHA-256 of a per-database salt, the machine id and the data folder) tells a copy of the data folder started
// on another machine, or in another folder, from this one; it never holds the machine id itself and does not depend on the master key, so a key rotation
// never makes this computer look like a copy.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/subgentic/coral/pkg/secretbox"
)

// Dropbox connection states.
const (
	DropboxStateDisconnected = "disconnected"
	DropboxStateConnected    = "connected"
	DropboxStateReconnect    = "reconnect"  // the token was discarded (a re-key) or refused by Dropbox: connect again
	DropboxStateQuotaFull    = "quota_full" // Dropbox said the account is full: the backup pauses (stage 4)
)

// ErrNoDropboxConnection is returned when this database holds no Dropbox sign-in.
var ErrNoDropboxConnection = errors.New("not connected to Dropbox")

// DropboxConnection is the safe view of the sign-in. It never carries the token.
type DropboxConnection struct {
	ServerID      string `json:"server_id"`
	AccountID     string `json:"account_id"`
	LastAccountID string `json:"last_account_id"`
	State         string `json:"state"`
	ConnectedAt   string `json:"connected_at"`
	Connected     bool   `json:"connected"`
}

// DropboxStore keeps the sign-in.
type DropboxStore struct {
	db *DB
	rs *RemoteServerStore // owns the master key loading/creation policy
}

// NewDropboxStore creates the store. rs supplies the shared master key.
func NewDropboxStore(db *DB, rs *RemoteServerStore) *DropboxStore {
	return &DropboxStore{db: db, rs: rs}
}

const dropboxAADPrefix = "dropbox-token:"

func dropboxAAD(accountID string) string { return dropboxAADPrefix + accountID }

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ensureRow makes the one row (a new server id and fingerprint salt) when there is none.
func (s *DropboxStore) ensureRow(ctx context.Context) error {
	id, err := randomHex(16)
	if err != nil {
		return err
	}
	salt, err := randomHex(32) // 32 random bytes from crypto/rand (Security, #14609)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO dropbox_connection (id, server_id, fp_salt, state) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING", id, salt, DropboxStateDisconnected)
	return err
}

// ServerID is this database's Dropbox server id, made the first time it is asked for.
func (s *DropboxStore) ServerID(ctx context.Context) (string, error) {
	if err := s.ensureRow(ctx); err != nil {
		return "", err
	}
	var id string
	err := s.db.GetContext(ctx, &id, "SELECT server_id FROM dropbox_connection WHERE id = 1")
	return id, err
}

// Fingerprint is this machine's fingerprint for the data folder dir: hex SHA-256 of the row's salt, machineID and dir.
func (s *DropboxStore) Fingerprint(ctx context.Context, machineID, dir string) (string, error) {
	if err := s.ensureRow(ctx); err != nil {
		return "", err
	}
	var salt string
	if err := s.db.GetContext(ctx, &salt, "SELECT fp_salt FROM dropbox_connection WHERE id = 1"); err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write([]byte(salt))
	h.Write([]byte{0})
	h.Write([]byte(machineID))
	h.Write([]byte{0})
	h.Write([]byte(dir))
	return hex.EncodeToString(h.Sum(nil)), nil
}

// FingerprintMatches says whether the stored fingerprint is this machine's for dir. No stored fingerprint (never connected) matches.
func (s *DropboxStore) FingerprintMatches(ctx context.Context, machineID, dir string) (bool, error) {
	want, err := s.Fingerprint(ctx, machineID, dir)
	if err != nil {
		return false, err
	}
	var got sql.NullString
	if err := s.db.GetContext(ctx, &got, "SELECT fingerprint FROM dropbox_connection WHERE id = 1"); err != nil {
		return false, err
	}
	if !got.Valid || got.String == "" {
		return true, nil
	}
	return subtle.ConstantTimeCompare([]byte(got.String), []byte(want)) == 1, nil
}

// TakeOver records this machine and data folder as the sign-in's own (the Operator's Take over, design §4b).
func (s *DropboxStore) TakeOver(ctx context.Context, machineID, dir string) error {
	fp, err := s.Fingerprint(ctx, machineID, dir)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE dropbox_connection SET fingerprint = ? WHERE id = 1", fp)
	return err
}

// Save records a new sign-in: the refresh token sealed and bound to accountID, the fingerprint of the machine that made it. The caller has already
// confirmed a switch when accountID is not the last account.
func (s *DropboxStore) Save(ctx context.Context, accountID, refreshToken, fingerprint string) error {
	if accountID == "" || refreshToken == "" {
		return errors.New("a Dropbox sign-in needs an account id and a refresh token")
	}
	if err := s.ensureRow(ctx); err != nil {
		return err
	}
	box, err := s.rs.getBox(ctx, true, false)
	if err != nil {
		return err
	}
	env, err := box.Seal(dropboxAAD(accountID), []byte(refreshToken))
	if err != nil {
		return err
	}
	// Every new sign-in starts with retention off (Security's answer 2 on #14703): the Operator turns it on again through the dry run.
	_, err = s.db.ExecContext(ctx, `UPDATE dropbox_connection SET account_id = ?, last_account_id = ?, refresh_token = ?, fingerprint = ?, state = ?, connected_at = ?,
		retention_days = 0, retention_since = NULL WHERE id = 1`,
		accountID, accountID, env, fingerprint, DropboxStateConnected, nowUTC())
	return err
}

// RefreshToken returns the decrypted refresh token, for a token call only: keep it in a local variable, never on a struct, in a log or in an error.
func (s *DropboxStore) RefreshToken(ctx context.Context) (string, error) {
	var r struct {
		Account sql.NullString `db:"account_id"`
		Token   sql.NullString `db:"refresh_token"`
	}
	err := s.db.GetContext(ctx, &r, "SELECT account_id, refresh_token FROM dropbox_connection WHERE id = 1")
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (!r.Token.Valid || !r.Account.Valid)) {
		return "", ErrNoDropboxConnection
	}
	if err != nil {
		return "", err
	}
	box, err := s.rs.getBox(ctx, false, false)
	if err != nil {
		return "", err
	}
	pt, err := box.Open(dropboxAAD(r.Account.String), r.Token.String)
	if err != nil {
		return "", unreadable(err)
	}
	tok := string(pt)
	secretbox.Zero(pt)
	return tok, nil
}

// Get returns the sign-in without its token. With no row yet it reports not connected.
func (s *DropboxStore) Get(ctx context.Context) (*DropboxConnection, error) {
	var r struct {
		ServerID string         `db:"server_id"`
		Account  sql.NullString `db:"account_id"`
		Last     sql.NullString `db:"last_account_id"`
		Token    sql.NullString `db:"refresh_token"`
		State    string         `db:"state"`
		At       sql.NullString `db:"connected_at"`
	}
	err := s.db.GetContext(ctx, &r, "SELECT server_id, account_id, last_account_id, refresh_token, state, connected_at FROM dropbox_connection WHERE id = 1")
	if errors.Is(err, sql.ErrNoRows) {
		return &DropboxConnection{State: DropboxStateDisconnected}, nil
	}
	if err != nil {
		return nil, err
	}
	return &DropboxConnection{ServerID: r.ServerID, AccountID: r.Account.String, LastAccountID: r.Last.String, State: r.State, ConnectedAt: r.At.String,
		Connected: r.Token.Valid && r.Account.Valid}, nil
}

// SetState records a state (for example reconnect, when Dropbox refuses the token). Only the three state constants are accepted (Security, #14618).
func (s *DropboxStore) SetState(ctx context.Context, state string) error {
	switch state {
	case DropboxStateDisconnected, DropboxStateConnected, DropboxStateReconnect, DropboxStateQuotaFull:
	default:
		return errors.New("not a Dropbox connection state")
	}
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET state = ? WHERE id = 1", state)
	return err
}

// Disconnect forgets the token, the account and the fingerprint; the server id and the last account stay.
func (s *DropboxStore) Disconnect(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET refresh_token = NULL, account_id = NULL, fingerprint = NULL, state = ?, connected_at = NULL, retention_days = 0, retention_since = NULL WHERE id = 1", DropboxStateDisconnected)
	return err
}

// Retention is stage 4b's setting (#14703): delete the Dropbox copies older than days (0 is off), and when the last pass ran (” never).
func (s *DropboxStore) Retention(ctx context.Context) (days int, lastPass string, err error) {
	if err := s.ensureRow(ctx); err != nil {
		return 0, "", err
	}
	var r struct {
		Days int            `db:"retention_days"`
		Last sql.NullString `db:"retention_last_pass"`
	}
	if err := s.db.GetContext(ctx, &r, "SELECT retention_days, retention_last_pass FROM dropbox_connection WHERE id = 1"); err != nil {
		return 0, "", err
	}
	return r.Days, r.Last.String, nil
}

// SetRetention records the setting; the caller has checked it (0 to 3650) and that it is the Operator's.
func (s *DropboxStore) SetRetention(ctx context.Context, days int) error {
	if days < 0 || days > 3650 {
		return errors.New("retention is 0 (off) to 3650 days")
	}
	if err := s.ensureRow(ctx); err != nil {
		return err
	}
	var since any
	if days > 0 {
		since = nowUTC()
	}
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET retention_days = ?, retention_since = ? WHERE id = 1", days, since)
	return err
}

// SetRetentionPass records when a retention pass ran (RFC 3339, UTC).
func (s *DropboxStore) SetRetentionPass(ctx context.Context, at string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET retention_last_pass = ? WHERE id = 1", at)
	return err
}

// DropboxAudit is one row of stage 4b's audit: a setting change or a retention pass. No names, paths, digests or tokens.
type DropboxAudit struct {
	At      string `db:"at" json:"at"`
	Kind    string `db:"kind" json:"kind"`
	Who     string `db:"who" json:"who"`
	OldDays int    `db:"old_days" json:"old_days"`
	NewDays int    `db:"new_days" json:"new_days"`
	Count   int    `db:"count" json:"count"`
	Bytes   int64  `db:"bytes" json:"bytes"`
	Held    int    `db:"held" json:"held"`
	Reason  string `db:"reason" json:"reason"`
}

// Audit kinds.
const (
	DropboxAuditSetting = "setting"
	DropboxAuditPass    = "pass"
	dropboxAuditKeep    = 500
)

// AddAudit writes one audit row and keeps the newest 500.
func (s *DropboxStore) AddAudit(ctx context.Context, a DropboxAudit) error {
	if a.Kind != DropboxAuditSetting && a.Kind != DropboxAuditPass {
		return errors.New("not a Dropbox audit kind")
	}
	if a.At == "" {
		a.At = nowUTC()
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO dropbox_audit (at, kind, who, old_days, new_days, count, bytes, held, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.At, a.Kind, a.Who, a.OldDays, a.NewDays, a.Count, a.Bytes, a.Held, a.Reason); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM dropbox_audit WHERE id <= (SELECT MAX(id) FROM dropbox_audit) - ?", dropboxAuditKeep)
	return err
}

// Audits returns the newest audit rows first, at most limit.
func (s *DropboxStore) Audits(ctx context.Context, limit int) ([]DropboxAudit, error) {
	var out []DropboxAudit
	err := s.db.SelectContext(ctx, &out, "SELECT at, kind, who, old_days, new_days, count, bytes, held, reason FROM dropbox_audit ORDER BY id DESC LIMIT ?", limit)
	return out, err
}

// Filters are the backup's choices (stage 4, #14655): the extensions to back up (none is every type) and the most days old an artifact may be
// (0 is no limit). Narrowing them never deletes anything already in Dropbox.
func (s *DropboxStore) Filters(ctx context.Context) (types []string, maxAgeDays int, err error) {
	if err := s.ensureRow(ctx); err != nil {
		return nil, 0, err
	}
	var r struct {
		Types string `db:"filter_types"`
		Days  int    `db:"max_age_days"`
	}
	if err := s.db.GetContext(ctx, &r, "SELECT filter_types, max_age_days FROM dropbox_connection WHERE id = 1"); err != nil {
		return nil, 0, err
	}
	for _, t := range strings.Split(r.Types, ",") {
		if t = strings.TrimSpace(t); t != "" {
			types = append(types, t)
		}
	}
	return types, r.Days, nil
}

// SetFilters records the backup's choices; the caller has checked them.
func (s *DropboxStore) SetFilters(ctx context.Context, types []string, maxAgeDays int) error {
	if err := s.ensureRow(ctx); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET filter_types = ?, max_age_days = ? WHERE id = 1", strings.Join(types, ","), maxAgeDays)
	return err
}
