package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// Sign once (#21889): what a computer remembers about the owner's anchor passkey and the browsers it certified. Nothing here decides who may do what: the verifier (internal/devicekey) does.

var (
	ErrAnchorForm       = errors.New("owner anchor is not well formed")
	ErrEpochLower       = errors.New("epoch is lower than the one stored")
	ErrEpochJump        = errors.New("epoch rises by more than the step cap")
	ErrCertifiedLimit   = errors.New("certified device limit reached")
	ErrUnknownCertified = errors.New("unknown certified device")
)

const (
	// EpochStepCap is the most one revocation statement may raise the stored epoch (Security MUST 4): a larger jump is refused, so a Hub that got one passkey touch cannot lock every real certificate out.
	EpochStepCap = 1000
	// CertifiedCap bounds the table: past it a browser never seen is refused until the person removes one.
	CertifiedCap = 200
)

// OwnerAnchor is the one passkey this computer learned at a pairing.
type OwnerAnchor struct {
	KID   string // base64url SHA-256 of PK
	PK    []byte // 65-byte point
	Cred  string // the credential id, base64url
	SetAt int64
}

// AnchorKID is the kid of an anchor's key.
func AnchorKID(pk []byte) string {
	s := sha256.Sum256(pk)
	return base64.RawURLEncoding.EncodeToString(s[:])
}

// SetOwnerAnchor stores the anchor. With no anchor stored it is a plain insert; with one stored it replaces it only when replace is true (the person at the computer chose Replace) and then drops every Keep. It returns whether
// the stored anchor is now this key.
func (s *SessionStore) SetOwnerAnchor(ctx context.Context, pk []byte, cred string, replace bool, now time.Time) (bool, error) {
	if len(pk) != 65 || pk[0] != 0x04 || cred == "" || len(cred) > 172 {
		return false, ErrAnchorForm
	}
	kid := AnchorKID(pk)
	cur, ok, err := s.OwnerAnchorRow(ctx)
	if err != nil {
		return false, err
	}
	if ok && cur.KID == kid {
		return true, nil
	}
	if ok && !replace {
		return false, nil
	}
	if ok {
		if err := s.dropKeeps(ctx); err != nil {
			return false, err
		}
		if _, err := s.db.ExecContext(ctx, `DELETE FROM owner_anchor`); err != nil {
			return false, err
		}
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO owner_anchor (kid, pk, cred, set_at) VALUES (?, ?, ?, ?)`, kid, pk, cred, now.Unix())
	return err == nil, err
}

// OwnerAnchorRow is the stored anchor, if any.
func (s *SessionStore) OwnerAnchorRow(ctx context.Context) (OwnerAnchor, bool, error) {
	var a OwnerAnchor
	err := s.db.QueryRowContext(ctx, `SELECT kid, pk, cred, set_at FROM owner_anchor LIMIT 1`).Scan(&a.KID, &a.PK, &a.Cred, &a.SetAt)
	if errors.Is(err, sql.ErrNoRows) {
		return OwnerAnchor{}, false, nil
	}
	return a, err == nil, err
}

// RemoveOwnerAnchor removes the anchor and drops every Keep (the denied rows stay).
func (s *SessionStore) RemoveOwnerAnchor(ctx context.Context) error {
	if err := s.dropKeeps(ctx); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM owner_anchor`)
	return err
}

func (s *SessionStore) dropKeeps(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE certified_devices SET kept_mode = '', kept_at = 0`)
	return err
}

// ClearOwnerCerts forgets everything: the anchor, the epochs and every certified browser, the denied ones too. It is for a new account's enrollment, never for a removal.
func (s *SessionStore) ClearOwnerCerts(ctx context.Context) error {
	for _, q := range []string{`DELETE FROM owner_anchor`, `DELETE FROM owner_epochs`, `DELETE FROM certified_devices`} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

// OwnerEpoch is the highest epoch seen for an anchor (0 when none).
func (s *SessionStore) OwnerEpoch(ctx context.Context, ownerKID string) (int64, error) {
	var e int64
	err := s.db.QueryRowContext(ctx, `SELECT epoch FROM owner_epochs WHERE owner_kid = ?`, ownerKID).Scan(&e)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return e, err
}

// RaiseOwnerEpoch stores epoch as the highest seen for the anchor. An equal epoch is fine and changes nothing; a lower one is ErrEpochLower; one more than EpochStepCap above the stored is ErrEpochJump and stores nothing.
func (s *SessionStore) RaiseOwnerEpoch(ctx context.Context, ownerKID string, epoch int64, now time.Time) error {
	if epoch < 0 {
		return ErrAnchorForm
	}
	cur, err := s.OwnerEpoch(ctx, ownerKID)
	if err != nil {
		return err
	}
	switch {
	case epoch < cur:
		return ErrEpochLower
	case epoch == cur:
		return nil
	case epoch-cur > EpochStepCap:
		return ErrEpochJump
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO owner_epochs (owner_kid, epoch, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_kid) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at WHERE excluded.epoch > owner_epochs.epoch`, ownerKID, epoch, now.Unix())
	return err
}

// CertifiedDevice is a browser an anchor certified, as this computer saw it.
type CertifiedDevice struct {
	KID, OwnerKID, Label string
	FirstSeen, LastSeen  int64
	KeptMode             string // "" until the person pressed Keep: the device is at view
	KeptAt               int64
	DeniedAt             int64 // set when the person pressed Remove; a denied kid never acts, whatever certificate it brings
}

// SeenCertifiedDevice records that a certified browser acted and returns its row, with first true when this computer had not seen it. A denied row is returned as it is (the verifier refuses it). The label is the
// browser's own word, stored cut to 64 bytes, and never changed after the first sight.
func (s *SessionStore) SeenCertifiedDevice(ctx context.Context, kid, ownerKID, label string, now time.Time) (CertifiedDevice, bool, error) {
	d, ok, err := s.CertifiedDeviceRow(ctx, kid)
	if err != nil {
		return CertifiedDevice{}, false, err
	}
	if ok {
		if d.OwnerKID != ownerKID { // another anchor certified it before: it is a new device for this one
			if d.DeniedAt != 0 {
				return d, false, nil
			}
			d.OwnerKID, d.KeptMode, d.KeptAt = ownerKID, "", 0
		}
		d.LastSeen = now.Unix()
		_, err := s.db.ExecContext(ctx, `UPDATE certified_devices SET last_seen = ?, owner_kid = ?, kept_mode = ?, kept_at = ? WHERE kid = ?`, d.LastSeen, d.OwnerKID, d.KeptMode, d.KeptAt, kid)
		return d, false, err
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM certified_devices`).Scan(&n); err != nil {
		return CertifiedDevice{}, false, err
	}
	if n >= CertifiedCap {
		return CertifiedDevice{}, false, ErrCertifiedLimit
	}
	if len(label) > deviceLabelMax {
		label = label[:deviceLabelMax]
	}
	d = CertifiedDevice{KID: kid, OwnerKID: ownerKID, Label: label, FirstSeen: now.Unix(), LastSeen: now.Unix()}
	_, err = s.db.ExecContext(ctx, `INSERT INTO certified_devices (kid, owner_kid, label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`, d.KID, d.OwnerKID, d.Label, d.FirstSeen, d.LastSeen)
	return d, true, err
}

// CertifiedDeviceRow is one certified browser's row, if this computer has seen it.
func (s *SessionStore) CertifiedDeviceRow(ctx context.Context, kid string) (CertifiedDevice, bool, error) {
	var d CertifiedDevice
	err := s.db.QueryRowContext(ctx, `SELECT kid, owner_kid, label, first_seen, last_seen, kept_mode, kept_at, denied_at FROM certified_devices WHERE kid = ?`, kid).
		Scan(&d.KID, &d.OwnerKID, &d.Label, &d.FirstSeen, &d.LastSeen, &d.KeptMode, &d.KeptAt, &d.DeniedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return CertifiedDevice{}, false, nil
	}
	return d, err == nil, err
}

// ListCertifiedDevices lists every certified browser this computer has seen, newest first.
func (s *SessionStore) ListCertifiedDevices(ctx context.Context) ([]CertifiedDevice, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT kid, owner_kid, label, first_seen, last_seen, kept_mode, kept_at, denied_at FROM certified_devices ORDER BY first_seen DESC, rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CertifiedDevice
	for rows.Next() {
		var d CertifiedDevice
		if err := rows.Scan(&d.KID, &d.OwnerKID, &d.Label, &d.FirstSeen, &d.LastSeen, &d.KeptMode, &d.KeptAt, &d.DeniedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// KeepCertifiedDevice is the person's Keep: the browser acts up to mode (view, interact or launch) on this computer from now on. It never un-denies a denied kid.
func (s *SessionStore) KeepCertifiedDevice(ctx context.Context, kid, mode string, now time.Time) error {
	if !validDeviceMode(mode) {
		return ErrDeviceKeyForm
	}
	res, err := s.db.ExecContext(ctx, `UPDATE certified_devices SET kept_mode = ?, kept_at = ? WHERE kid = ? AND denied_at = 0`, mode, now.Unix(), kid)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownCertified
	}
	return nil
}

// DenyCertifiedDevice is the person's Remove: the kid is refused from now on, whatever certificate it brings. The row outlives any certificate and every Keep. A kid never seen is denied too (a row is made).
func (s *SessionStore) DenyCertifiedDevice(ctx context.Context, kid, label string, now time.Time) error {
	if kid == "" || len(kid) > 64 {
		return ErrDeviceKeyForm
	}
	if len(label) > deviceLabelMax {
		label = label[:deviceLabelMax]
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO certified_devices (kid, owner_kid, label, first_seen, last_seen, denied_at) VALUES (?, '', ?, ?, ?, ?)
		ON CONFLICT(kid) DO UPDATE SET denied_at = excluded.denied_at, kept_mode = '', kept_at = 0`, kid, label, now.Unix(), now.Unix(), now.Unix())
	return err
}

// OwnerCertAcceptSetting is this computer's own setting "accept owner-certified devices up to <mode>" (#21889): off (the default, and what any unreadable or unknown value reads as), view, interact or launch. Only the person here changes it (never a browser, the Hub or an agent).
const OwnerCertAcceptSetting = "owner_cert_accept"

// OwnerCertAccept is the setting: the mode and whether it is on. Fail closed: no row, a read error or a word that is not a mode is off.
func (s *SessionStore) OwnerCertAccept(ctx context.Context) (string, bool) {
	all, err := s.GetSettings(ctx)
	if err != nil {
		return "", false
	}
	if m := all[OwnerCertAcceptSetting]; validDeviceMode(m) {
		return m, true
	}
	return "", false
}

// SetOwnerCertAccept saves the setting: "off", "view", "interact" or "launch".
func (s *SessionStore) SetOwnerCertAccept(ctx context.Context, mode string) error {
	if mode != "off" && !validDeviceMode(mode) {
		return ErrDeviceKeyForm
	}
	return s.SetSetting(ctx, OwnerCertAcceptSetting, mode)
}
