package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"strings"

	"golang.org/x/net/idna"

	"github.com/subgentic/coral/pkg/secretbox"
)

// Link states (design v2 section 1). Only active is written in this slice; the others are read by the later ones.
const (
	LinkStateActive   = "active"
	LinkStatePaused   = "paused"
	LinkStateRevoked  = "revoked"
	LinkStateRemoving = "removing"
)

// MaxCloudLinks is the most Hubs one computer links to (Security SHOULD 2).
const MaxCloudLinks = 8

// linkMaxModeKey is the setting that holds today's one cap (settings.CloudMaxMode); the first link takes its value.
const linkMaxModeKey = "cloud_max_mode"

// CloudLink is the safe view of one link. It never carries the token.
type CloudLink struct {
	LinkID         string  `json:"link_id" db:"link_id"`
	HubOrigin      string  `json:"hub_origin" db:"hub_origin"`
	ServerID       string  `json:"server_id" db:"server_id"`
	Label          string  `json:"label" db:"label"`
	State          string  `json:"state" db:"state"`
	MaxMode        string  `json:"max_mode" db:"max_mode"`
	Scope          string  `json:"scope" db:"scope"`
	OwnerAccount   string  `json:"owner_account" db:"owner_account"`
	OwnerUser      string  `json:"owner_user" db:"owner_user"`
	OwnerAdoptedAt *string `json:"owner_adopted_at" db:"owner_adopted_at"`
	CreatedAt      string  `json:"created_at" db:"created_at"`
	LastSeen       *string `json:"last_seen" db:"last_seen"`
	LastError      *string `json:"last_error" db:"last_error"`
	// Source is "enrollment" for the link the one enrollment mirrors, "added" for one added here (#20368). Never sent anywhere.
	Source string `json:"-" db:"source"`
}

// Link sources.
const (
	LinkSourceEnrollment = "enrollment"
	LinkSourceAdded      = "added"
)

// ErrNoCloudLink is returned for a link id or origin that is not linked.
var ErrNoCloudLink = errors.New("no such Coral Hub link")

func linkAAD(linkID string) string { return "cloud-link:" + linkID }

// NewLinkID makes a link's local handle: "lnk-" and 8 hex digits, random, never a Hub's value.
func NewLinkID() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "lnk-" + hex.EncodeToString(b[:]), nil
}

// CanonicalHubOrigin is the key of a link: scheme://host[:port] in lower case. An address with a path (other than a bare slash), a query, a fragment or user information is refused, not collapsed. The host in punycode, a trailing dot
// and the scheme's default port dropped. https only; http is accepted for a loopback host (a dev Hub on this computer). Anything else is an error, so two spellings of one Hub are
// one key and a URL that names no Hub is no key.
func CanonicalHubOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", errors.New("not a Hub address")
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(strings.TrimSpace(raw), "#") {
		return "", errors.New("a Hub address is the site only: no path, query or fragment")
	}
	if u.User != nil {
		return "", errors.New("a Hub address has no user name or password")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" {
		return "", errors.New("a Hub address needs a host")
	}
	loopback := host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
	scheme := strings.ToLower(u.Scheme)
	switch {
	case scheme == "https":
	case scheme == "http" && loopback:
	default:
		return "", errors.New("a Hub address must be https")
	}
	if net.ParseIP(host) == nil { // a name goes to punycode; an address is kept as it is
		ascii, err := idna.Lookup.ToASCII(host)
		if err != nil {
			return "", errors.New("not a valid Hub host name")
		}
		host = ascii
	}
	port := u.Port()
	if port == "443" && scheme == "https" || port == "80" && scheme == "http" {
		port = ""
	}
	if strings.Contains(host, ":") { // an IPv6 literal
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host, nil
}

// legacyHubOrigin is the key for an enrollment that already exists (an upgrade never breaks Coral): CanonicalHubOrigin, and for an address that has only a path, query or fragment too
// many, the same address cut to its site. It is used only to find or mirror the one existing enrollment, never to add a link: nothing that adds a link calls it, and no flag or
// setting reaches it. The second result is true when the address had to be cut.
func legacyHubOrigin(raw string) (string, bool, error) {
	if o, err := CanonicalHubOrigin(raw); err == nil {
		return o, false, nil
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil {
		return "", false, errors.New("not a Hub address")
	}
	cut := *u
	cut.Path, cut.RawPath, cut.RawQuery, cut.ForceQuery, cut.Fragment, cut.RawFragment = "", "", "", false, "", ""
	o, err := CanonicalHubOrigin(cut.String())
	if err != nil {
		return "", false, err
	}
	return o, true, nil
}

// HubAddressWarning is the sentence for an enrolled address that has a path, query or fragment, or "" when it has none. It names the cut origin only, never the saved address (a saved query could carry a value that must not be shown).
func HubAddressWarning(raw string) string {
	o, cut, err := legacyHubOrigin(raw)
	if err != nil || !cut {
		return ""
	}
	return "The saved Hub address (" + o + ") has extra parts. Links keep working as they are; a new link needs the bare address."
}

// HubAddressHasPath reports whether an enrolled Hub address is one only the legacy path accepts (it has a path, query or fragment): Settings and the log warn about it.
func HubAddressHasPath(raw string) bool {
	_, cut, err := legacyHubOrigin(raw)
	return err == nil && cut
}

// ListLinks returns every link, oldest first, without tokens.
func (s *CloudStore) ListLinks(ctx context.Context) ([]CloudLink, error) {
	var out []CloudLink
	err := s.db.SelectContext(ctx, &out, `SELECT link_id, hub_origin, server_id, label, state, max_mode, scope, owner_account, owner_user, owner_adopted_at, created_at, last_seen, last_error, source
		FROM cloud_link ORDER BY created_at, rowid`)
	if err == nil {
		s.liveCap(ctx, out)
	}
	return out, err
}

// liveCap makes the cap a list shows the one the checks read: for the link the one enrollment mirrors that is the setting cloud_max_mode (the max-mode route, the launch flag and Connect write only the setting), so there is
// one source of truth and the list, CLI and Settings never disagree with it (Security's MUST on #20346). A link added here has its own cap.
func (s *CloudStore) liveCap(ctx context.Context, ls []CloudLink) {
	for i := range ls {
		if ls[i].Source == LinkSourceEnrollment {
			ls[i].MaxMode = s.settingMaxMode(ctx)
		}
	}
}

// LinkByOrigin returns the link for a Hub address (any spelling CanonicalHubOrigin accepts).
func (s *CloudStore) LinkByOrigin(ctx context.Context, hubURL string) (*CloudLink, error) {
	origin, _, err := legacyHubOrigin(hubURL) // a lookup only: a link with a path exists only when the legacy mirror made it
	if err != nil {
		return nil, ErrNoCloudLink
	}
	var l CloudLink
	err = s.db.GetContext(ctx, &l, `SELECT link_id, hub_origin, server_id, label, state, max_mode, scope, owner_account, owner_user, owner_adopted_at, created_at, last_seen, last_error, source
		FROM cloud_link WHERE hub_origin = ?`, origin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoCloudLink
	}
	if err == nil {
		one := []CloudLink{l}
		s.liveCap(ctx, one)
		l = one[0]
	}
	return &l, err
}

// LinkExists reports whether id is an active link on this computer: a paused, revoked or removing link is "no" (Security's point 8). A store error is "no": the caller refuses.
func (s *CloudStore) LinkExists(ctx context.Context, id string) bool {
	var n int
	return s.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link WHERE link_id = ? AND state = ?", id, LinkStateActive) == nil && n == 1
}

// LinkToken returns a link's decrypted token, for dialing only (see Token). A link with no token (one made paused because its token could not be read) returns ErrKeyUnreadable.
func (s *CloudStore) LinkToken(ctx context.Context, linkID string) (string, error) {
	var env string
	err := s.db.GetContext(ctx, &env, "SELECT token FROM cloud_link WHERE link_id = ?", linkID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoCloudLink
	}
	if err != nil {
		return "", err
	}
	box, err := s.rs.getBox(ctx, false, false)
	if err != nil {
		return "", err
	}
	pt, err := box.Open(linkAAD(linkID), env)
	if err != nil {
		return "", unreadable(err)
	}
	tok := string(pt)
	secretbox.Zero(pt)
	return tok, nil
}

// legacyRow is the one cloud_connection row, as the link is made from it.
type legacyRow struct {
	HubURL        string         `db:"hub_url"`
	ServerID      string         `db:"server_id"`
	Label         string         `db:"label"`
	Token         string         `db:"token"`
	State         string         `db:"state"`
	LastError     sql.NullString `db:"last_error"`
	CreatedAt     string         `db:"created_at"`
	HubOwner      sql.NullString `db:"hub_owner"`
	HubOwnerUser  sql.NullString `db:"hub_owner_user"`
	HubOwnerAdopt sql.NullString `db:"hub_owner_adopted_at"`
}

const legacyCols = "hub_url, server_id, label, token, state, last_error, created_at, hub_owner, hub_owner_user, hub_owner_adopted_at"

// validMode reports whether m is a tier name a link may have as its cap.
func validMode(m string) bool { return m == "view" || m == "interact" || m == "launch" }

// MirrorLegacyLink makes cloud_link match the one cloud_connection row (design v2 section 6, slice 1): no row there leaves no link; a row there is one link, made once
// (a later call finds it and only refreshes its state and owner pin). The token is re-sealed under the link's own AAD, opened again and compared with the old one before anything
// is written, and the link is written in one transaction: on any failure the old row stays as it is and no link is made. A token that cannot be read makes the link paused with no
// token ("re-enrol"), and Coral starts as it did. It is safe to call on every start and after every change to the enrollment.
func (s *CloudStore) MirrorLegacyLink(ctx context.Context) error {
	var row legacyRow
	err := s.db.GetContext(ctx, &row, "SELECT "+legacyCols+" FROM cloud_connection WHERE id = 1")
	if errors.Is(err, sql.ErrNoRows) {
		_, err = s.db.ExecContext(ctx, "DELETE FROM cloud_link WHERE source = 'enrollment'") // a link added here is not the enrollment's to remove
		return err
	}
	if err != nil {
		return err
	}
	origin, cut, err := legacyHubOrigin(row.HubURL)
	if err != nil {
		return fmt.Errorf("the enrolled Hub address is not usable as a link: %w", err)
	}
	if cut {
		log.Printf("WARNING: the saved Hub address for %s has extra parts; it keeps working as saved, but enroll again with the bare address", origin)
	}
	var existing string
	err = s.db.GetContext(ctx, &existing, "SELECT link_id FROM cloud_link WHERE hub_origin = ? AND server_id = ? AND source = 'enrollment'", origin, row.ServerID)
	switch {
	case err == nil:
		return s.refreshLink(ctx, existing, row)
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}

	// A new link. Prepare the sealed token before the transaction.
	id, err := NewLinkID()
	if err != nil {
		return err
	}
	state, lastErr, env := row.State, row.LastError, ""
	box, err := s.rs.getBox(ctx, false, false)
	var plain []byte
	if err == nil {
		plain, err = box.Open(cloudAAD(row.ServerID), row.Token)
	}
	if err != nil {
		// The token can't be read: the link is made paused with no token, and says to enrol again.
		state = LinkStatePaused
		lastErr = sql.NullString{String: "re-enrol: the saved Hub token can't be read", Valid: true}
	} else {
		defer secretbox.Zero(plain)
		if env, err = box.Seal(linkAAD(id), plain); err != nil {
			return err
		}
		back, err := box.Open(linkAAD(id), env)
		if err != nil || string(back) != string(plain) {
			return errors.New("the re-sealed Hub token does not match the old one; the link was not made")
		}
		secretbox.Zero(back)
	}
	mode := s.settingMaxMode(ctx)

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM cloud_link WHERE source = 'enrollment'"); err != nil { // one enrollment, one link: a link added here stays
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, scope, owner_account, owner_user, owner_adopted_at, created_at, last_error)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'all', ?, ?, ?, ?, ?)`,
		id, origin, row.ServerID, row.Label, env, state, mode, row.HubOwner.String, row.HubOwnerUser.String, nullStr(row.HubOwnerAdopt), nowUTC(), nullStr(lastErr)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *CloudStore) refreshLink(ctx context.Context, linkID string, row legacyRow) error {
	_, err := s.db.ExecContext(ctx, `UPDATE cloud_link SET label = ?, state = CASE WHEN state IN (?, ?) THEN state ELSE ? END, owner_account = ?, owner_user = ?, owner_adopted_at = ?, last_error = ? WHERE link_id = ?`,
		row.Label, LinkStatePaused, LinkStateRemoving, row.State, row.HubOwner.String, row.HubOwnerUser.String, nullStr(row.HubOwnerAdopt), nullStr(row.LastError), linkID)
	return err
}

// settingMaxMode is today's saved cap, or view (the least) when none is saved or the value is not a tier name.
func (s *CloudStore) settingMaxMode(ctx context.Context) string {
	var v string
	if err := s.db.GetContext(ctx, &v, "SELECT value FROM user_settings WHERE key = ?", linkMaxModeKey); err != nil {
		return "view"
	}
	if v = strings.ToLower(strings.TrimSpace(v)); validMode(v) {
		return v
	}
	return "view"
}

func nullStr(n sql.NullString) any {
	if n.Valid && n.String != "" {
		return n.String
	}
	return nil
}

// mirror keeps the link in step with the enrollment after a change to it. The links are not what the connector reads yet, so a failure here must not fail the change that
// caused it (an upgrade never breaks Coral): the next start's MirrorLegacyLink tries again and reports.
func (s *CloudStore) mirror(ctx context.Context) { _ = s.MirrorLegacyLink(ctx) }
