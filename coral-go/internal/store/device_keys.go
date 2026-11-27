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

	// PairOwner is the explicit marker, in both columns of the pair, of a key made at this computer by its owner (#20513). A pair that is empty or half a marker fails closed everywhere: nothing is assumed to be the owner's.
	PairOwner = "(owner)"
	// PairBrowserBy is the raised_by mark of a key the person allowed at this computer through the pair-a-browser flow (#21880): the Needs you notice reads it ("<label> can now act on this computer as <mode>").
	PairBrowserBy = "pair-browser"

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
	deviceNonceLen       = 22 // 16 random bytes as base64url without padding
)

var (
	ErrDeviceKeyForm    = errors.New("device key is not well formed")
	ErrUnknownSigner    = errors.New("unknown device key")
	ErrSignerRemoved    = errors.New("device key is removed or expired")
	ErrKeyLimit         = errors.New("device key limit reached")
	ErrNonceRepeat      = errors.New("nonce already accepted")
	ErrNonceForm        = errors.New("nonce is not 22 base64url characters of 16 bytes")
	ErrNonceStoreFull   = errors.New("nonce store is full")
	ErrClockBack        = errors.New("the computer's clock is behind the latest accepted time")
	deviceNonceKidShare = 1000  // one signer may hold this many live nonces, so a stolen one cannot fill the cap
	deviceNonceCap      = 10000 // a count cap: a new message is refused before a live nonce is dropped
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
	// Link and HubUser are the pair the computer set when it made the row (M1, #20514): the Hub link and the Hub label of the person whose key this is. Both empty is the owner's own key, made at this computer.
	Link    string
	HubUser string
	// ApprovedBy is the kid of the key (or passkey) whose signed message or certificate made this row; empty for a key made at this computer (M3, #20514).
	ApprovedBy string
	// ViaPasskey is the passkey kid whose certificate made this device; such a device acts only on itself (M5).
	ViaPasskey string
	// ChangedAt is when the row was made or its mode last changed (unix seconds): what the owner's notice (M4) is dated by.
	ChangedAt int64
	// RaisedBy is who last raised this key's mode: the signer's kid for a signed raise, PairOwner for one made at this computer, empty if never raised (M4: the owner's notice names the raiser, not the approver).
	RaisedBy string
}

// PairState says what the row's pair is: owner (both columns the marker), bound (a link and a Hub label, neither the marker) or neither (anything else, which every check refuses).
func (k DeviceKey) PairState() (owner, bound bool) {
	switch {
	case k.Link == PairOwner && k.HubUser == PairOwner:
		return true, false
	case k.Link != "" && k.HubUser != "" && k.Link != PairOwner && k.HubUser != PairOwner && len(k.Link) <= 64 && len(k.HubUser) <= 25:
		return false, true
	}
	return false, false
}

func (k DeviceKey) formOK() bool {
	if o, b := k.PairState(); !o && !b {
		return false
	}
	if len(k.PK) != 65 || k.PK[0] != 0x04 || len(k.Label) > deviceLabelMax || !validDeviceMode(k.Mode) {
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

const deviceCols = `kid, pk, label, mode, origin, kind, created_at, last_used_at, removed_at, removed_reason, link, hub_user, approved_by, via_passkey, changed_at, raised_by`

func scanDeviceKey(row interface{ Scan(...any) error }) (DeviceKey, error) {
	var k DeviceKey
	var used, rem sql.NullInt64
	var reason sql.NullString
	if err := row.Scan(&k.KID, &k.PK, &k.Label, &k.Mode, &k.Origin, &k.Kind, &k.CreatedAt, &used, &rem, &reason, &k.Link, &k.HubUser, &k.ApprovedBy, &k.ViaPasskey, &k.ChangedAt, &k.RaisedBy); err != nil {
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO device_keys (`+deviceCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, '')`, k.KID, k.PK, k.Label, k.Mode, k.Origin, k.Kind, now.Unix(), k.Link, k.HubUser, k.ApprovedBy, k.ViaPasskey, now.Unix()); err != nil {
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

// TouchDeviceKey records a use, which pushes the 90-day expiry out. A removed, unknown or already idle-expired key is left alone: a touch never brings one back. Call it only after a signature has verified.
func (s *SessionStore) TouchDeviceKey(ctx context.Context, kid string, now time.Time) error {
	cutoff := now.Unix() - int64(deviceIdleExpiry/time.Second)
	_, err := s.db.ExecContext(ctx, `UPDATE device_keys SET last_used_at = ? WHERE kid = ? AND removed_at IS NULL AND COALESCE(last_used_at, created_at) > ?`, now.Unix(), kid, cutoff)
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

// PromoteDeviceOrigin raises an active key's origin from bootstrap or noproof to pairing, and does nothing else: it is the only way an origin changes and there is no way back. The pairing-proof path (devicekey.CompletePairing) is its one caller, which a source scan test holds.
func (s *SessionStore) PromoteDeviceOrigin(ctx context.Context, kid string, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE device_keys SET origin = ? WHERE kid = ? AND removed_at IS NULL AND origin IN (?, ?)`, DeviceOriginPairing, kid, DeviceOriginBootstrap, DeviceOriginNoProof)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// validDeviceMode: coral-hub's wire format has exactly these three modes.
func validDeviceMode(m string) bool { return m == "view" || m == "interact" || m == "launch" }

// SetDeviceMode changes the stored mode of an active key and records who raised it: by is the signer's kid, or "" for a change made at this computer (stored as PairOwner). Who may ask is the verifier's rule, not this method's.
func (s *SessionStore) SetDeviceMode(ctx context.Context, kid, mode, by string, now time.Time) error {
	if by == "" {
		by = PairOwner
	}
	if !validDeviceMode(mode) {
		return ErrDeviceKeyForm
	}
	if _, err := s.ActiveDeviceKey(ctx, kid, now); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE device_keys SET mode = ?, changed_at = ?, raised_by = ? WHERE kid = ? AND removed_at IS NULL`, mode, now.Unix(), by, kid)
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

// RecordNonce accepts a message's nonce in one transaction: the clock check, the repeat check, the count cap, then the insert and the high-water mark. It is kept for the message's window plus twice the 5 minute skew. A refused call writes nothing.
func (s *SessionStore) RecordNonce(ctx context.Context, nonce, kid string, now time.Time, window time.Duration) error {
	return s.recordNonce(ctx, nonce, kid, "", deviceNonceKidShare, 0, now, window)
}

// Sign once (#21889, Security): a certified browser draws from its own pool, one per anchor, so many certified browsers cannot crowd out the owner's own device keys. 200 live nonces per certified browser and 1000 per anchor; a full pool refuses the new message and never drops a live nonce.
const (
	CertNonceKidShare  = 200
	CertNoncePoolShare = 1000
)

// RecordCertNonce is RecordNonce for a certified browser: the nonce is counted under the anchor's pool and the browser's own share.
func (s *SessionStore) RecordCertNonce(ctx context.Context, nonce, anchorKID, deviceKID string, now time.Time, window time.Duration) error {
	pool := "cert:" + anchorKID + ":"
	return s.recordNonce(ctx, nonce, pool+deviceKID, pool, CertNonceKidShare, CertNoncePoolShare, now, window)
}

func (s *SessionStore) recordNonce(ctx context.Context, nonce, kid, pool string, kidShare, poolShare int, now time.Time, window time.Duration) error {
	if b, err := base64.RawURLEncoding.Strict().DecodeString(nonce); err != nil || len(nonce) != deviceNonceLen || len(b) != 16 {
		return ErrNonceForm
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := checkClock(ctx, tx, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM device_nonces WHERE nonce = ? AND expires_at < ?`, nonce, now.Unix()); err != nil {
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
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_nonces WHERE expires_at >= ?`, now.Unix()).Scan(&live); err != nil {
		return err
	}
	if live >= deviceNonceCap {
		return ErrNonceStoreFull
	}
	var mine int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_nonces WHERE kid = ? AND expires_at >= ?`, kid, now.Unix()).Scan(&mine); err != nil {
		return err
	}
	if mine >= kidShare {
		return ErrNonceStoreFull
	}
	if pool != "" {
		var inPool int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM device_nonces WHERE substr(kid, 1, ?) = ? AND expires_at >= ?`, len(pool), pool, now.Unix()).Scan(&inPool); err != nil {
			return err
		}
		if inPool >= poolShare {
			return ErrNonceStoreFull
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO device_nonces (nonce, kid, accepted_at, expires_at) VALUES (?, ?, ?, ?)`, nonce, kid, now.Unix(), now.Add(window+2*deviceNonceSkew).Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO device_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = MAX(v, excluded.v)`, deviceHighWaterKey, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// NonceSeen reports ErrNonceRepeat when the nonce is still kept, and writes nothing.
func (s *SessionStore) NonceSeen(ctx context.Context, nonce string, now time.Time) error {
	var one int
	switch err := s.db.QueryRowContext(ctx, `SELECT 1 FROM device_nonces WHERE nonce = ? AND expires_at >= ?`, nonce, now.Unix()).Scan(&one); {
	case err == nil:
		return ErrNonceRepeat
	case errors.Is(err, sql.ErrNoRows):
		return nil
	default:
		return err
	}
}

// PruneNonces drops the nonces whose keep time is over.
func (s *SessionStore) PruneNonces(ctx context.Context, now time.Time) (int, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM device_nonces WHERE expires_at < ?`, now.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// RemoveAllDeviceKeys removes every active key with reason removed. It is what a re-link of this computer to another Hub account does (#19669, coral-hub Lead's Q1): the list has no account column, so a key trusted for
// account A must never verify for account B, and the person pairs again. Removed entries are kept as always.
func (s *SessionStore) RemoveAllDeviceKeys(ctx context.Context, now time.Time) (int, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE device_keys SET removed_at = ?, removed_reason = 'removed' WHERE removed_at IS NULL`, now.Unix())
	if err != nil {
		return 0, err
	}
	if err := s.ClearOwnerCerts(ctx); err != nil { // a new account starts with no anchor, no epoch and no certified browser
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// ClearClockMark is the owner's reset after a clock jump (CheckClock fails closed): the mark becomes now. It is safe because the nonces keep their own expiry times, which a clock set back only lengthens. Only the
// computer's owner may call it (a local command), never a device or the Hub.
func (s *SessionStore) ClearClockMark(ctx context.Context, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO device_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, deviceHighWaterKey, now.Unix())
	return err
}

// ClockMark is the latest time a signed action was accepted (0 when none), for the notice that says what the clock was compared with.
func (s *SessionStore) ClockMark(ctx context.Context) (time.Time, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, `SELECT v FROM device_meta WHERE k = ?`, deviceHighWaterKey).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, nil
	}
	return time.Unix(v, 0), err
}

// DeviceWebModeSetting is the computer's own setting for the mode a browser paired through the `#p=` link starts at. Beta default launch (a dated decision, 2026-11-18: coral-hub's Part G item 6; first reviewed at the start of the closed beta's second week, or sooner if a device signs something unexpected). Only this computer's person changes it (the dashboard here and `coral cloud devices`); never a paired browser or the Hub.
const DeviceWebModeSetting = "device_web_mode"

// DeviceWebModeDefault is the beta default.
const DeviceWebModeDefault = "launch"

// DeviceWebMode is the mode a newly paired browser gets. Fail safe (QA on slice 5): no row at all is the dated beta default (launch); but a read error, or a stored word that is not view, interact or launch, is view, the lowest. A person who lowered the setting never gets more than they set because a read failed.
func (s *SessionStore) DeviceWebMode(ctx context.Context) string {
	all, err := s.GetSettings(ctx)
	if err != nil {
		return "view"
	}
	m, set := all[DeviceWebModeSetting]
	if !set {
		return DeviceWebModeDefault
	}
	if validDeviceMode(m) {
		return m
	}
	return "view"
}

// SetDeviceWebMode saves the web mode: only view, interact or launch.
func (s *SessionStore) SetDeviceWebMode(ctx context.Context, mode string) error {
	if !validDeviceMode(mode) {
		return ErrDeviceKeyForm
	}
	return s.SetSetting(ctx, DeviceWebModeSetting, mode)
}

const deviceClearPendingKey = "clear_pending"

// SetDeviceClearPending records (true) or ends (false) "a clear of the device list is under way or failed": written before the clear and ended only when a clear worked, so a failed clear, a crash or a restart cannot end it (coral-hub Security, #19717). It lives in the device tables, not in user settings: no settings route can write it.
func (s *SessionStore) SetDeviceClearPending(ctx context.Context, pending bool) error {
	if pending {
		_, err := s.db.ExecContext(ctx, `INSERT INTO device_meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = 1`, deviceClearPendingKey)
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM device_meta WHERE k = ?`, deviceClearPendingKey)
	return err
}

// DeviceClearPending is whether a clear is pending. Fail closed: a read that errors says true.
func (s *SessionStore) DeviceClearPending(ctx context.Context) bool {
	var v int64
	err := s.db.QueryRowContext(ctx, `SELECT v FROM device_meta WHERE k = ?`, deviceClearPendingKey).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	return err != nil || v != 0
}

// WasRemoved reports whether kid is on the list as removed by a person (reason "removed"), as opposed to expired from disuse or not listed. A key a person removed is not paired again by a signed message (#20514 SHOULD).
func (s *SessionStore) WasRemoved(ctx context.Context, kid string) (bool, error) {
	var reason sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT removed_reason FROM device_keys WHERE kid = ? AND removed_at IS NOT NULL`, kid).Scan(&reason)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return reason.String == DeviceRemoved, err
}
