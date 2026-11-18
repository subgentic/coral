package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// The device list and the nonce store of Coral's device keys (#19669 slice 1, design page v4 section 5). This file only stores and ages: it checks no signature and decides no authority (the verifier, slice 3, does).
// Every method takes the time as an argument: Coral's own clock is the only clock, and a test sets it. Times are unix seconds.

const (
	DeviceKindDevice  = "device"
	DeviceKindPasskey = "passkey"

	DeviceOriginPairing   = "pairing"   // a person paired it with proof
	DeviceOriginBootstrap = "bootstrap" // added by the bootstrap credential: never approves or raises
	DeviceOriginNoProof   = "noproof"   // added without proof: neither adds passkeys nor approves

	DeviceRemoved = "removed"
	DeviceExpired = "expired"

	deviceIdleExpiry     = 90 * 24 * time.Hour // unused this long: expired and entered on the removed list
	deviceRemovedKeep    = 90 * 24 * time.Hour // a removed entry stays this long from its removal...
	deviceRemovedMin     = 25 * time.Hour      // ...and never leaves earlier than this (24 h certificate age plus the 5 minute skew)
	deviceRemovedSoftCap = 200                 // past it the purge takes the oldest entry past 25 h, expired before removed
	deviceRemovedCeiling = 400                 // at it only a NEW pairing is refused; a removal never is
	deviceMaxActive      = 10
	devicePasskeyMax     = 5
	deviceNonceSkew      = 5 * time.Minute
	deviceLabelMax       = 64
	deviceHighWaterKey   = "high_water"
)

var (
	ErrDeviceKeyForm  = errors.New("device key is not well formed")
	ErrUnknownSigner  = errors.New("unknown device key")
	ErrSignerRemoved  = errors.New("device key is removed or expired")
	ErrKeyLimit       = errors.New("device key limit reached")
	ErrNonceRepeat    = errors.New("nonce already accepted")
	ErrNonceStoreFull = errors.New("nonce store is full")
	ErrClockBack      = errors.New("the computer's clock is behind the latest accepted time")
	deviceNonceCap    = 10000 // a count cap: a new message is refused before a live nonce is dropped
)

// DeviceKey is one row of the device list.
type DeviceKey struct {
	KID           string
	PK            []byte // the raw 65-byte point
	Label         string
	Mode          string
	Origin        string
	Kind          string
	CreatedAt     int64
	LastUsedAt    int64 // 0 is never used
	RemovedAt     int64 // 0 is active
	RemovedReason string
}

func (k DeviceKey) formOK() bool {
	if len(k.PK) != 65 || k.PK[0] != 0x04 || len(k.Label) > deviceLabelMax || k.Mode == "" || len(k.Mode) > 32 {
		return false
	}
	sum := sha256.Sum256(k.PK)
	if k.KID != base64.RawURLEncoding.EncodeToString(sum[:]) {
		return false
	}
	switch k.Origin {
	case DeviceOriginPairing, DeviceOriginBootstrap, DeviceOriginNoProof:
	default:
		return false
	}
	return k.Kind == DeviceKindDevice || k.Kind == DeviceKindPasskey
}

const deviceCols = `kid, pk, label, mode, origin, kind, created_at, last_used_at, removed_at, removed_reason`

func scanDeviceKey(row interface{ Scan(...any) error }) (DeviceKey, error) {
	var k DeviceKey
	var used, rem sql.NullInt64
	var reason sql.NullString
	if err := row.Scan(&k.KID, &k.PK, &k.Label, &k.Mode, &k.Origin, &k.Kind, &k.CreatedAt, &used, &rem, &reason); err != nil {
		return DeviceKey{}, err
	}
	k.LastUsedAt, k.RemovedAt, k.RemovedReason = used.Int64, rem.Int64, reason.String
	return k, nil
}

// idleExpired reports a device key unused for 90 days at now (counted from its last use, or its creation).
func (k DeviceKey) idleExpired(now time.Time) bool {
	from := k.LastUsedAt
	if from == 0 {
		from = k.CreatedAt
	}
	return now.Unix() >= from+int64(deviceIdleExpiry/time.Second)
}

// AddDeviceKey adds a key. A key already active is a success with no write (added false) and keeps its first label. A removed or expired entry that is still listed becomes a fresh active key (the person proved the
// pairing again). A key not listed is refused with ErrKeyLimit when the active devices are 10, the passkeys 5, or the removed list is at its hard ceiling of 400 (only a new pairing; a removal is never refused).
func (s *SessionStore) AddDeviceKey(ctx context.Context, k DeviceKey, now time.Time) (added bool, err error) {
	if !k.formOK() {
		return false, ErrDeviceKeyForm
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	ex, err := scanDeviceKey(tx.QueryRowContext(ctx, `SELECT `+deviceCols+` FROM device_keys WHERE kid = ?`, k.KID))
	switch {
	case err == nil && ex.RemovedAt == 0 && !ex.idleExpired(now):
		return false, nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return false, err
	}
	if err == nil { // listed but removed or expired: replaced by the fresh pairing
		if _, err := tx.ExecContext(ctx, `DELETE FROM device_keys WHERE kid = ?`, k.KID); err != nil {
			return false, err
		}
	}
	var removed, active int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_keys WHERE removed_at IS NOT NULL`).Scan(&removed); err != nil {
		return false, err
	}
	if removed >= deviceRemovedCeiling {
		return false, ErrKeyLimit
	}
	max := deviceMaxActive
	if k.Kind == DeviceKindPasskey {
		max = devicePasskeyMax
	}
	cutoff := now.Unix() - int64(deviceIdleExpiry/time.Second)
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_keys WHERE removed_at IS NULL AND kind = ? AND COALESCE(last_used_at, created_at) > ?`, k.Kind, cutoff).Scan(&active); err != nil {
		return false, err
	}
	if active >= max {
		return false, ErrKeyLimit
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO device_keys (`+deviceCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`, k.KID, k.PK, k.Label, k.Mode, k.Origin, k.Kind, now.Unix()); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// ActiveDeviceKey returns the key for a signer: ErrUnknownSigner when it is not listed (never added, or purged), ErrSignerRemoved when it is removed or has been idle for 90 days (expired is read at once, before the sweep runs).
func (s *SessionStore) ActiveDeviceKey(ctx context.Context, kid string, now time.Time) (DeviceKey, error) {
	k, err := scanDeviceKey(s.db.QueryRowContext(ctx, `SELECT `+deviceCols+` FROM device_keys WHERE kid = ?`, kid))
	if errors.Is(err, sql.ErrNoRows) {
		return DeviceKey{}, ErrUnknownSigner
	}
	if err != nil {
		return DeviceKey{}, err
	}
	if k.RemovedAt != 0 || k.idleExpired(now) {
		return DeviceKey{}, ErrSignerRemoved
	}
	return k, nil
}

// ListDeviceKeys lists every row, active and removed, oldest first.
func (s *SessionStore) ListDeviceKeys(ctx context.Context) ([]DeviceKey, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+deviceCols+` FROM device_keys ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceKey
	for rows.Next() {
		k, err := scanDeviceKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// TouchDeviceKey records a use, which pushes the 90-day expiry out. A removed or unknown key is left alone.
func (s *SessionStore) TouchDeviceKey(ctx context.Context, kid string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE device_keys SET last_used_at = ? WHERE kid = ? AND removed_at IS NULL`, now.Unix(), kid)
	return err
}

// RemoveDeviceKey removes a key with a reason (removed or expired). It is never refused for a number, and removing twice keeps the first time. Only an unknown key is an error.
func (s *SessionStore) RemoveDeviceKey(ctx context.Context, kid, reason string, now time.Time) error {
	if reason != DeviceRemoved && reason != DeviceExpired {
		return ErrDeviceKeyForm
	}
	res, err := s.db.ExecContext(ctx, `UPDATE device_keys SET removed_at = ?, removed_reason = ? WHERE kid = ? AND removed_at IS NULL`, now.Unix(), reason, kid)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var one int
		if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM device_keys WHERE kid = ?`, kid).Scan(&one); errors.Is(err, sql.ErrNoRows) {
			return ErrUnknownSigner
		}
	}
	return nil
}

// SetDeviceMode changes the stored mode of an active key. Who may ask is the verifier's rule, not this method's.
func (s *SessionStore) SetDeviceMode(ctx context.Context, kid, mode string, now time.Time) error {
	if mode == "" || len(mode) > 32 {
		return ErrDeviceKeyForm
	}
	if _, err := s.ActiveDeviceKey(ctx, kid, now); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE device_keys SET mode = ? WHERE kid = ? AND removed_at IS NULL`, mode, kid)
	return err
}

// ExpireDeviceKeys enters every active key idle for 90 days on the removed list with reason expired, at the time it expired.
func (s *SessionStore) ExpireDeviceKeys(ctx context.Context, now time.Time) (int, error) {
	cutoff := now.Unix() - int64(deviceIdleExpiry/time.Second)
	res, err := s.db.ExecContext(ctx, `UPDATE device_keys SET removed_at = COALESCE(last_used_at, created_at) + ?, removed_reason = 'expired' WHERE removed_at IS NULL AND COALESCE(last_used_at, created_at) <= ?`, int64(deviceIdleExpiry/time.Second), cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// PurgeDeviceKeys drops removed entries 90 days after their removal, then, past the soft cap of 200, the oldest entries that are over 25 hours old, expired before removed. Nothing under 25 hours goes, whatever the count.
func (s *SessionStore) PurgeDeviceKeys(ctx context.Context, now time.Time) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	old := now.Unix() - int64(deviceRemovedKeep/time.Second)
	res, err := tx.ExecContext(ctx, `DELETE FROM device_keys WHERE removed_at IS NOT NULL AND removed_at <= ? AND removed_at <= ?`, old, now.Unix()-int64(deviceRemovedMin/time.Second))
	if err != nil {
		return 0, err
	}
	n64, _ := res.RowsAffected()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_keys WHERE removed_at IS NOT NULL`).Scan(&count); err != nil {
		return 0, err
	}
	if over := count - deviceRemovedSoftCap; over > 0 {
		res, err := tx.ExecContext(ctx, `DELETE FROM device_keys WHERE kid IN (SELECT kid FROM device_keys WHERE removed_at IS NOT NULL AND removed_at <= ?
			ORDER BY (removed_reason = 'expired') DESC, removed_at, rowid LIMIT ?)`, now.Unix()-int64(deviceRemovedMin/time.Second), over)
		if err != nil {
			return 0, err
		}
		m, _ := res.RowsAffected()
		n64 += m
	}
	return int(n64), tx.Commit()
}

// CheckClock refuses (ErrClockBack) when now is behind the latest time a signed action was accepted: a clock set back would otherwise reopen the nonce windows. A store newer than the clock (a restored older clock) reads the same.
func (s *SessionStore) CheckClock(ctx context.Context, now time.Time) error {
	return checkClock(ctx, s.db, now)
}

type deviceQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func checkClock(ctx context.Context, q deviceQuerier, now time.Time) error {
	var mark int64
	err := q.QueryRowContext(ctx, `SELECT v FROM device_meta WHERE k = ?`, deviceHighWaterKey).Scan(&mark)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if now.Unix() < mark {
		return ErrClockBack
	}
	return nil
}

// RecordNonce accepts a message's nonce in one transaction: the clock check, the repeat check, the count cap, then the insert and the high-water mark. It is kept for the message's window plus the 5 minute skew. A refused call writes nothing.
func (s *SessionStore) RecordNonce(ctx context.Context, nonce, kid string, now time.Time, window time.Duration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := checkClock(ctx, tx, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM device_nonces WHERE nonce = ? AND expires_at <= ?`, nonce, now.Unix()); err != nil {
		return err
	}
	var one int
	switch err := tx.QueryRowContext(ctx, `SELECT 1 FROM device_nonces WHERE nonce = ?`, nonce).Scan(&one); {
	case err == nil:
		return ErrNonceRepeat
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	var live int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_nonces WHERE expires_at > ?`, now.Unix()).Scan(&live); err != nil {
		return err
	}
	if live >= deviceNonceCap {
		return ErrNonceStoreFull
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO device_nonces (nonce, kid, accepted_at, expires_at) VALUES (?, ?, ?, ?)`, nonce, kid, now.Unix(), now.Add(window+deviceNonceSkew).Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO device_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = MAX(v, excluded.v)`, deviceHighWaterKey, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// PruneNonces drops the nonces whose keep time is over.
func (s *SessionStore) PruneNonces(ctx context.Context, now time.Time) (int, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM device_nonces WHERE expires_at <= ?`, now.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
