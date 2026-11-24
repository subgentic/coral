package store

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// A second Hub asks to join this Coral (#20936, design #20901 v4). The store holds a pending request; nothing is linked, stored as a token or granted by it. The Operator at this computer Allows (and is shown an
// 8-digit code once) or Denies; the Hub then finishes with the request's poll secret and the code. The secret and the code are kept only as salted HMACs and compared in constant time.

// Limits of a request (design section 7).
const (
	LinkRequestPendingTTL = 10 * time.Minute // to Allow or Deny
	LinkRequestAllowedTTL = 5 * time.Minute  // from Allow to a right code
	LinkRequestMaxTries   = 5                // wrong codes before the request is dead
	linkRequestHubLen     = 80               // a Hub address longer than this is refused, never cut
	linkRequestPerHub     = 1                // waiting at once for one Hub address
	linkRequestPerCred    = 3                // waiting at once for one credential
	linkRequestCredHour   = 5                // requests an hour for one credential
	linkRequestHubHour    = 3                // requests an hour for one Hub address
	linkRequestMuteAfter  = 2                // denials from one Hub address within the hour that mute it
	linkRequestMuteFor    = time.Hour
)

// Errors of a request. ErrLinkRequestNone answers an unknown id, a wrong poll secret and a dead request alike.
var (
	ErrLinkRequestNone  = errors.New("no such request")
	ErrLinkRequestState = errors.New("that request is not waiting for that")
	ErrLinkRequestCode  = errors.New("that is not the code")
	ErrLinkRequestCap   = errors.New("a Hub cannot be given more than it asked for")
	ErrLinkRequestBusy  = errors.New("too many requests waiting")
	ErrLinkRequestRate  = errors.New("too many requests in the last hour")
	ErrLinkRequestMuted = errors.New("that Hub's requests were denied twice, or ended by wrong codes (a run of wrong codes counts as guessing): it may ask again in an hour")
)

// LinkRequest is a request as the Needs-you feed and the Hub's status see it. Never the poll secret or the code.
type LinkRequest struct {
	ID        string    `json:"id" db:"request_id"`
	Hub       string    `json:"hub" db:"hub_origin"`
	CapAsked  string    `json:"cap_asked" db:"cap_asked"`
	CapGiven  string    `json:"cap_given,omitempty" db:"cap_given"`
	State     string    `json:"state" db:"state"`
	Tries     int       `json:"-" db:"tries"`
	CreatedAt time.Time `json:"created_at" db:"-"`
	ExpiresAt time.Time `json:"expires_at" db:"-"`
	Via       string    `json:"via,omitempty" db:"-"` // the name of the key that asked, when one did
	CreatedS  string    `json:"-" db:"created_at"`
	ExpiresS  string    `json:"-" db:"expires_at"`
}

const linkRequestCols = `request_id, hub_origin, cap_asked, cap_given, state, tries, created_at, expires_at`

func (r *LinkRequest) parse() {
	r.CreatedAt, _ = time.Parse(ISOFormat, r.CreatedS)
	r.ExpiresAt, _ = time.Parse(ISOFormat, r.ExpiresS)
}

func lrTime(t time.Time) string { return t.UTC().Format(ISOFormat) }

func lrRandHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func lrHash(salt, value string) string {
	m := hmac.New(sha256.New, []byte(salt))
	m.Write([]byte(value))
	return hex.EncodeToString(m.Sum(nil))
}

func lrSame(salt, value, want string) bool {
	return subtle.ConstantTimeCompare([]byte(lrHash(salt, value)), []byte(want)) == 1
}

func capRank(c string) int {
	switch c {
	case "view":
		return 1
	case "interact":
		return 2
	case "launch":
		return 3
	}
	return 0
}

// expireLinkRequests moves the requests whose time is up to expired (a read of the table is the same as the clock: nothing waits on a timer).
func (s *CloudStore) expireLinkRequests(ctx context.Context, now time.Time) {
	_, _ = s.db.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'expired', ended_at = ? WHERE state IN ('pending','allowed') AND expires_at <= ?`, lrTime(now), lrTime(now))
}

// CreateLinkRequest records that the Hub at hub asks to join with cap. Everything that can be refused is refused here, before any card: a bad address (an address over 80 characters is refused, not cut), a bad cap,
// a Hub already linked, a full computer, a muted Hub, too many waiting and too many an hour. cred names the credential (or "" for the person at this computer) the limits count per. It returns the request id and the
// poll secret, shown once.
func (s *CloudStore) CreateLinkRequest(ctx context.Context, hub, linkCap, cred string, now time.Time) (id, pollSecret string, err error) {
	origin, err := CanonicalHubOrigin(hub)
	if err != nil {
		return "", "", err
	}
	if len(origin) > linkRequestHubLen {
		return "", "", errors.New("that Hub's address is too long")
	}
	if !validMode(linkCap) {
		return "", "", errors.New("choose what this Hub may do here: view, interact or launch")
	}
	if l, lerr := s.LinkByOrigin(ctx, origin); lerr == nil && l != nil || s.AddedLinkAt(ctx, origin) {
		return "", "", ErrLinkExists
	}
	if err := s.CheckCanAddLink(ctx); err != nil {
		return "", "", err
	}
	// One write-first transaction from the first count to the insert, so two creates at once cannot both pass a limit (QA's SHOULD 2 on #20936). The connection is single, so nothing else runs in between.
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'expired', ended_at = ? WHERE state IN ('pending','allowed') AND expires_at <= ?`, lrTime(now), lrTime(now)); err != nil {
		return "", "", err
	}
	hourAgo := lrTime(now.Add(-time.Hour))
	count := func(q string, args ...any) (int, error) {
		var n int
		err := tx.GetContext(ctx, &n, q, args...)
		return n, err
	}
	denied, err := count(`SELECT COUNT(*) FROM cloud_link_request WHERE hub_origin = ? AND state = 'denied' AND ended_at >= ?`, origin, lrTime(now.Add(-linkRequestMuteFor)))
	if err != nil {
		return "", "", err
	}
	if denied >= linkRequestMuteAfter {
		return "", "", ErrLinkRequestMuted
	}
	waitHub, err := count(`SELECT COUNT(*) FROM cloud_link_request WHERE hub_origin = ? AND state IN ('pending','allowed')`, origin)
	if err != nil {
		return "", "", err
	}
	waitCred, err := count(`SELECT COUNT(*) FROM cloud_link_request WHERE cred_id = ? AND state IN ('pending','allowed')`, cred)
	if err != nil {
		return "", "", err
	}
	if waitHub >= linkRequestPerHub || waitCred >= linkRequestPerCred {
		return "", "", ErrLinkRequestBusy
	}
	hourCred, err := count(`SELECT COUNT(*) FROM cloud_link_request WHERE cred_id = ? AND created_at >= ?`, cred, hourAgo)
	if err != nil {
		return "", "", err
	}
	hourHub, err := count(`SELECT COUNT(*) FROM cloud_link_request WHERE hub_origin = ? AND created_at >= ?`, origin, hourAgo)
	if err != nil {
		return "", "", err
	}
	if hourCred >= linkRequestCredHour || hourHub >= linkRequestHubHour {
		return "", "", ErrLinkRequestRate
	}
	idHex, err := lrRandHex(8)
	if err != nil {
		return "", "", err
	}
	if pollSecret, err = lrRandHex(16); err != nil {
		return "", "", err
	}
	salt, err := lrRandHex(16)
	if err != nil {
		return "", "", err
	}
	id = "req-" + idHex
	if _, err = tx.ExecContext(ctx, `INSERT INTO cloud_link_request (request_id, hub_origin, cap_asked, state, cred_id, poll_salt, poll_hash, created_at, expires_at)
		VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`, id, origin, linkCap, cred, salt, lrHash(salt, pollSecret), lrTime(now), lrTime(now.Add(LinkRequestPendingTTL))); err != nil {
		return "", "", err
	}
	if err := tx.Commit(); err != nil {
		return "", "", err
	}
	return id, pollSecret, nil
}

type lrRow struct {
	LinkRequest
	CredID   string `db:"cred_id"`
	PollSalt string `db:"poll_salt"`
	PollHash string `db:"poll_hash"`
	CodeSalt string `db:"code_salt"`
	CodeHash string `db:"code_hash"`
}

type lrQuerier interface {
	GetContext(ctx context.Context, dest any, query string, args ...any) error
}

func lrLoad(ctx context.Context, q lrQuerier, id string) (*lrRow, error) {
	var r lrRow
	err := q.GetContext(ctx, &r, `SELECT `+linkRequestCols+`, cred_id, poll_salt, poll_hash, code_salt, code_hash FROM cloud_link_request WHERE request_id = ?`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrLinkRequestNone
	}
	if err != nil {
		return nil, err
	}
	r.parse()
	return &r, nil
}

// LinkRequestStatus is the Hub's poll: pending, allowed, denied, expired or done, never the code. A wrong secret and an unknown id answer the same.
func (s *CloudStore) LinkRequestStatus(ctx context.Context, id, pollSecret string, now time.Time) (string, error) {
	s.expireLinkRequests(ctx, now)
	r, err := lrLoad(ctx, s.db, id)
	if err != nil || !lrSame(r.PollSalt, pollSecret, r.PollHash) {
		return "", ErrLinkRequestNone
	}
	if r.State == "consumed" {
		return "done", nil
	}
	return r.State, nil
}

// PendingLinkRequests are the requests waiting for the Operator, oldest first: what the Needs-you card shows.
func (s *CloudStore) PendingLinkRequests(ctx context.Context, now time.Time) ([]LinkRequest, error) {
	s.expireLinkRequests(ctx, now)
	out := []LinkRequest{}
	if err := s.db.SelectContext(ctx, &out, `SELECT `+linkRequestCols+` FROM cloud_link_request WHERE state = 'pending' ORDER BY rowid`); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].parse()
		var via string
		if err := s.db.GetContext(ctx, &via, `SELECT k.name FROM cloud_link_request q JOIN cloud_link_key k ON k.key_id = q.cred_id WHERE q.request_id = ?`, out[i].ID); err == nil {
			out[i].Via = via
		}
	}
	return out, nil
}

// LinkRequestByID reads one request for the Operator's own routes (no secret needed: the caller is the person here).
func (s *CloudStore) LinkRequestByID(ctx context.Context, id string, now time.Time) (*LinkRequest, error) {
	s.expireLinkRequests(ctx, now)
	r, err := lrLoad(ctx, s.db, id)
	if err != nil {
		return nil, err
	}
	return &r.LinkRequest, nil
}

// AllowLinkRequest is the Operator's Allow. capGiven may be lower than asked, never higher, and is bounded by this computer's own max mode. It returns the 8-digit code, once, and the cap given. The code goes only to
// the caller of this call: it is stored as a salted HMAC and is in no other read.
func (s *CloudStore) AllowLinkRequest(ctx context.Context, id, capGiven string, now time.Time) (code, given string, err error) {
	s.expireLinkRequests(ctx, now)
	r, err := lrLoad(ctx, s.db, id)
	if err != nil {
		return "", "", err
	}
	if r.State != "pending" {
		return "", "", ErrLinkRequestState
	}
	if !validMode(capGiven) {
		return "", "", errors.New("choose what this Hub may do here: view, interact or launch")
	}
	if capRank(capGiven) > capRank(r.CapAsked) {
		return "", "", ErrLinkRequestCap
	}
	given = capGiven
	if capRank(s.settingMaxMode(ctx)) < capRank(given) {
		given = s.settingMaxMode(ctx)
	}
	n, err := rand.Int(rand.Reader, big.NewInt(100000000))
	if err != nil {
		return "", "", err
	}
	code = fmt.Sprintf("%08d", n.Int64())
	salt, err := lrRandHex(16)
	if err != nil {
		return "", "", err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'allowed', cap_given = ?, code_salt = ?, code_hash = ?, allowed_at = ?, expires_at = ? WHERE request_id = ? AND state = 'pending'`,
		given, salt, lrHash(salt, code), lrTime(now), lrTime(now.Add(LinkRequestAllowedTTL)), id)
	if err != nil {
		return "", "", err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", "", ErrLinkRequestState
	}
	return code, given, nil
}

// DenyLinkRequest is the Operator's Deny of a waiting request, and also the Cancel connection after Allow: an allowed request that has not finished ends at once (a later finish gets the same none). A waiting
// one ends 'denied' (two of those mute the Hub); an allowed one the Operator takes back ends 'expired', so a change of mind does not mute.
func (s *CloudStore) DenyLinkRequest(ctx context.Context, id string, now time.Time) error {
	s.expireLinkRequests(ctx, now)
	res, err := s.db.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'denied', ended_at = ? WHERE request_id = ? AND state = 'pending'`, lrTime(now), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		res, err = s.db.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'expired', ended_at = ? WHERE request_id = ? AND state = 'allowed'`, lrTime(now), id)
		if err != nil {
			return err
		}
	}
	if n, _ := res.RowsAffected(); n != 1 {
		if _, lerr := lrLoad(ctx, s.db, id); lerr != nil {
			return lerr
		}
		return ErrLinkRequestState
	}
	return nil
}

// CancelLinkRequest drops a request that was never allowed (the Hub gave up); an allowed one is left to its own clock.
func (s *CloudStore) CancelLinkRequest(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'expired', ended_at = ? WHERE request_id = ? AND state = 'pending'`, nowUTC(), id)
	return err
}

// FinishLinkRequest is the Hub's finish: in one transaction it checks the secret (first, so the code is never hinted at), the state, the clock, the tries and the code, and marks the request consumed before anything
// is enrolled, so two finishes at once make one link. It returns only the origin that was Allowed and the cap given; finish takes no address. Five wrong codes end the request.
func (s *CloudStore) FinishLinkRequest(ctx context.Context, id, pollSecret, code string, now time.Time) (hub, linkCap string, err error) {
	return s.FinishLinkRequestBy(ctx, id, pollSecret, code, "", now)
}

// FinishLinkRequestBy is FinishLinkRequest for a caller that is a request key (#20959, defence in depth beside the poll secret): a request made with one key is finished only by that key, and any other key, or
// none, gets the same none as an unknown request. A person at this computer passes key "" and is not held to it.
func (s *CloudStore) FinishLinkRequestBy(ctx context.Context, id, pollSecret, code, key string, now time.Time) (hub, linkCap string, err error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback() //nolint:errcheck
	// A write first, so two finishes take the database's write lock in turn and the second reads the consumed row.
	if _, err := tx.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'expired', ended_at = ? WHERE state IN ('pending','allowed') AND expires_at <= ?`, lrTime(now), lrTime(now)); err != nil {
		return "", "", err
	}
	r, err := lrLoad(ctx, tx, id)
	if err != nil || !lrSame(r.PollSalt, pollSecret, r.PollHash) {
		return "", "", ErrLinkRequestNone
	}
	if strings.HasPrefix(r.CredID, "lk-") && key != r.CredID { // made with a key: only that key finishes it
		return "", "", ErrLinkRequestNone
	}
	if key != "" && key != r.CredID {
		return "", "", ErrLinkRequestNone
	}
	switch r.State {
	case "allowed":
	case "pending":
		return "", "", ErrLinkRequestState
	default: // denied, expired, consumed
		return "", "", ErrLinkRequestNone
	}
	if !lrSame(r.CodeSalt, code, r.CodeHash) {
		tries := r.Tries + 1
		state := "allowed"
		if tries >= LinkRequestMaxTries {
			state = "denied"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE cloud_link_request SET tries = ?, state = ?, ended_at = CASE WHEN ? = 'denied' THEN ? ELSE ended_at END WHERE request_id = ?`, tries, state, state, lrTime(now), id); err != nil {
			return "", "", err
		}
		if err := tx.Commit(); err != nil {
			return "", "", err
		}
		return "", "", ErrLinkRequestCode
	}
	if _, err := tx.ExecContext(ctx, `UPDATE cloud_link_request SET state = 'consumed', ended_at = ? WHERE request_id = ?`, lrTime(now), id); err != nil {
		return "", "", err
	}
	if err := tx.Commit(); err != nil {
		return "", "", err
	}
	return r.Hub, r.CapGiven, nil
}
