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
	MaxLinkKeys     = 8  // live keys at once on this computer
	MaxLinkKeysVia  = 3  // live keys at once that one Hub link made (#20966)
	LinkKeysPerHour = 10 // keys one Hub link may make in an hour, revoked ones counted (#20966)
	linkKeyNameMax  = 40 // characters
)

var (
	ErrLinkKeyNone  = errors.New("no such key")
	ErrLinkKeyName  = errors.New("a key needs a name of 1 to 40 characters, with no control characters, that no other live key has")
	ErrLinkKeyLimit = errors.New("this computer has the most keys it can have: revoke one first")
	// ErrLinkKeyLinkLimit and ErrLinkKeyRate are the limits of a key made through a Hub (#20966): three live keys and ten made an hour, per link.
	ErrLinkKeyLinkLimit = errors.New("that Hub link already has the most request keys it may have: revoke one first")
	ErrLinkKeyRate      = errors.New("that Hub link has made request keys too often: try again in an hour")
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
	return s.CreateLinkKeyVia(ctx, name, "", now)
}

// CreateLinkKeyVia is CreateLinkKey for a key a Hub's owner asked for through link (#20966): besides the computer's own eight, at most three live keys and ten made in an hour belong to one link. link "" is the
// person at this computer, who is held to the eight only. The counts and the insert are one transaction, so two makes at once cannot both take the last place.
func (s *CloudStore) CreateLinkKeyVia(ctx context.Context, name, link string, now time.Time) (id, key string, err error) {
	name, ok := cleanLinkKeyName(name)
	if !ok {
		return "", "", ErrLinkKeyName
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback() //nolint:errcheck
	// A write first, so two makes at once take the database's write lock in turn and the second counts the first.
	if _, err := tx.ExecContext(ctx, `UPDATE cloud_link_key SET via_link = via_link WHERE key_id = ''`); err != nil {
		return "", "", err
	}
	var live int
	if err := tx.GetContext(ctx, &live, `SELECT COUNT(*) FROM cloud_link_key WHERE revoked_at = ''`); err != nil {
		return "", "", err
	}
	if live >= MaxLinkKeys {
		return "", "", ErrLinkKeyLimit
	}
	if link != "" {
		var liveVia, hour int
		if err := tx.GetContext(ctx, &liveVia, `SELECT COUNT(*) FROM cloud_link_key WHERE revoked_at = '' AND via_link = ?`, link); err != nil {
			return "", "", err
		}
		if liveVia >= MaxLinkKeysVia {
			return "", "", ErrLinkKeyLinkLimit
		}
		if err := tx.GetContext(ctx, &hour, `SELECT COUNT(*) FROM cloud_link_key WHERE via_link = ? AND created_at >= ?`, link, lrTime(now.Add(-time.Hour))); err != nil {
			return "", "", err
		}
		if hour >= LinkKeysPerHour {
			return "", "", ErrLinkKeyRate
		}
	}
	var same int
	if err := tx.GetContext(ctx, &same, `SELECT COUNT(*) FROM cloud_link_key WHERE revoked_at = '' AND lower(name) = lower(?)`, name); err != nil {
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO cloud_link_key (key_id, name, key_salt, key_hash, created_at, via_link) VALUES (?, ?, ?, ?, ?, ?)`, id, name, salt, lrHash(salt, secret), lrTime(now), link); err != nil {
		return "", "", err
	}
	if err := tx.Commit(); err != nil {
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

// ListLinkKeysVia are the live keys one Hub link made (#20966), oldest first: what that link's owner may see of the keys. Never a key or a hash.
func (s *CloudStore) ListLinkKeysVia(ctx context.Context, link string) ([]LinkKey, error) {
	var rows []linkKeyRow
	if err := s.db.SelectContext(ctx, &rows, `SELECT key_id, name, key_salt, key_hash, created_at, last_used_at FROM cloud_link_key WHERE revoked_at = '' AND via_link = ? AND via_link <> '' ORDER BY rowid`, link); err != nil {
		return nil, err
	}
	out := make([]LinkKey, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.view())
	}
	return out, nil
}

// RevokeLinkKeyVia ends a key for a Hub's owner (#20966): only one that same link made. Another link's key, a key made at this computer and a key that is not there are the same ErrLinkKeyNone, so a Hub learns nothing
// about its neighbours.
func (s *CloudStore) RevokeLinkKeyVia(ctx context.Context, id, link string, now time.Time) error {
	var n int
	if err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM cloud_link_key WHERE key_id = ? AND via_link = ? AND via_link <> '' AND revoked_at = ''`, id, link); err != nil {
		return err
	}
	if n == 0 {
		return ErrLinkKeyNone
	}
	return s.RevokeLinkKey(ctx, id, now)
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
