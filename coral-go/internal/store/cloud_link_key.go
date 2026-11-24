package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// A self-hosted Hub's request key (#20944, design #20901 v5 to v7). The key is "lrk_<id>_<secret>": shown once by CreateLinkKey, kept only as a salted HMAC, compared in constant time. It proves who asked; it grants nothing. What
// it may call (create, status and finish of its own join request) is enforced in the server's identity middleware, and a join still needs the person's Allow and code at this computer.

const (
	MaxLinkKeys    = 8  // live keys at once on this computer
	linkKeyNameMax = 40 // characters
)

var (
	ErrLinkKeyNone  = errors.New("no such key")
	ErrLinkKeyName  = errors.New("a key needs a name of 1 to 40 characters, with no control characters, that no other live key has")
	ErrLinkKeyLimit = errors.New("this computer has the most keys it can have: revoke one first")
)

// LinkKey is a key as a list shows it: never the key, never its hash.
type LinkKey struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"` // zero when it has not been used
}

type linkKeyRow struct {
	ID       string `db:"key_id"`
	Name     string `db:"name"`
	Salt     string `db:"key_salt"`
	Hash     string `db:"key_hash"`
	Created  string `db:"created_at"`
	LastUsed string `db:"last_used_at"`
}

func (r linkKeyRow) view() LinkKey {
	c, _ := time.Parse(ISOFormat, r.Created)
	u, _ := time.Parse(ISOFormat, r.LastUsed)
	return LinkKey{ID: r.ID, Name: r.Name, CreatedAt: c, LastUsedAt: u}
}

func cleanLinkKeyName(n string) (string, bool) {
	n = strings.TrimSpace(n)
	if n == "" || utf8.RuneCountInString(n) > linkKeyNameMax || !utf8.ValidString(n) {
		return "", false
	}
	for _, r := range n {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return "", false
		}
	}
	return n, true
}

// CreateLinkKey makes a key. It returns the key once; only a hash is stored.
func (s *CloudStore) CreateLinkKey(ctx context.Context, name string, now time.Time) (id, key string, err error) {
	name, ok := cleanLinkKeyName(name)
	if !ok {
		return "", "", ErrLinkKeyName
	}
	var live int
	if err := s.db.GetContext(ctx, &live, `SELECT COUNT(*) FROM cloud_link_key WHERE revoked_at = ''`); err != nil {
		return "", "", err
	}
	if live >= MaxLinkKeys {
		return "", "", ErrLinkKeyLimit
	}
	var same int
	if err := s.db.GetContext(ctx, &same, `SELECT COUNT(*) FROM cloud_link_key WHERE revoked_at = '' AND lower(name) = lower(?)`, name); err != nil {
		return "", "", err
	}
	if same > 0 {
		return "", "", ErrLinkKeyName
	}
	idPart, err := lrRandHex(4)
	if err != nil {
		return "", "", err
	}
	secret, err := lrRandHex(16)
	if err != nil {
		return "", "", err
	}
	salt, err := lrRandHex(16)
	if err != nil {
		return "", "", err
	}
	id = "lk-" + idPart
	key = "lrk_" + idPart + "_" + secret
	if _, err := s.db.ExecContext(ctx, `INSERT INTO cloud_link_key (key_id, name, key_salt, key_hash, created_at) VALUES (?, ?, ?, ?, ?)`, id, name, salt, lrHash(salt, secret), lrTime(now)); err != nil {
		return "", "", err
	}
	return id, key, nil
}

// VerifyLinkKey reports whether key is a live key, and which. It records the use. Any malformed, unknown, wrong or revoked key is the same "no".
func (s *CloudStore) VerifyLinkKey(ctx context.Context, key string, now time.Time) (LinkKey, bool) {
	rest, ok := strings.CutPrefix(key, "lrk_")
	if !ok {
		return LinkKey{}, false
	}
	idPart, secret, ok := strings.Cut(rest, "_")
	if !ok || len(idPart) != 8 || len(secret) != 32 {
		return LinkKey{}, false
	}
	var r linkKeyRow
	if err := s.db.GetContext(ctx, &r, `SELECT key_id, name, key_salt, key_hash, created_at, last_used_at FROM cloud_link_key WHERE key_id = ? AND revoked_at = ''`, "lk-"+idPart); err != nil {
		return LinkKey{}, false
	}
	if !lrSame(r.Salt, secret, r.Hash) {
		return LinkKey{}, false
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE cloud_link_key SET last_used_at = ? WHERE key_id = ?`, lrTime(now), r.ID)
	r.LastUsed = lrTime(now)
	return r.view(), true
}

// ListLinkKeys are the live keys, oldest first. Never a key or a hash.
func (s *CloudStore) ListLinkKeys(ctx context.Context) ([]LinkKey, error) {
	var rows []linkKeyRow
	if err := s.db.SelectContext(ctx, &rows, `SELECT key_id, name, key_salt, key_hash, created_at, last_used_at FROM cloud_link_key WHERE revoked_at = '' ORDER BY rowid`); err != nil {
		return nil, err
	}
	out := make([]LinkKey, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.view())
	}
	return out, nil
}

// RevokeLinkKey ends a key and the requests it left waiting (pending or allowed): a revoked key's Hub cannot finish one.
func (s *CloudStore) RevokeLinkKey(ctx context.Context, id string, now time.Time) error {
	res, err := s.db.ExecContext(ctx, `UPDATE cloud_link_key SET revoked_at = ? WHERE key_id = ? AND revoked_at = ''`, lrTime(now), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrLinkKeyNone
	}
	_, err = s.db.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'expired', ended_at = ? WHERE cred_id = ? AND state IN ('pending','allowed')`, lrTime(now), id)
	return err
}
