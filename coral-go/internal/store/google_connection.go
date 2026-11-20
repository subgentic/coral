package store

// This database's Google sign-in (#20022, Google Doc share), built like the Dropbox one (dropbox_connection.go). The refresh token is sealed with the same
// master key as the other secrets (secretbox, AES-256-GCM, the key outside the database), bound to the Google account id as AAD; it moves with a key rotation
// and is discarded by a re-key into the "reconnect" state. The safe view never carries it, and the access token is never stored (it lives in memory).

import (
	"context"
	"database/sql"
	"errors"

	"github.com/subgentic/coral/pkg/secretbox"
)

// Google connection states.
const (
	GoogleStateDisconnected = "disconnected"
	GoogleStateConnected    = "connected"
	GoogleStateReconnect    = "reconnect" // the token was discarded (a re-key) or refused by Google: connect again
)

// ErrNoGoogleConnection is returned when this database holds no Google sign-in.
var ErrNoGoogleConnection = errors.New("not connected to Google")

// GoogleConnection is the safe view of the sign-in. It never carries the token.
type GoogleConnection struct {
	AccountID   string `json:"account_id"`
	State       string `json:"state"`
	ConnectedAt string `json:"connected_at"`
	Connected   bool   `json:"connected"`
}

// GoogleStore keeps the sign-in.
type GoogleStore struct {
	db *DB
	rs *RemoteServerStore // owns the master key loading/creation policy
}

// NewGoogleStore creates the store. rs supplies the shared master key.
func NewGoogleStore(db *DB, rs *RemoteServerStore) *GoogleStore { return &GoogleStore{db: db, rs: rs} }

const googleAADPrefix = "google-token:"

func googleAAD(accountID string) string { return googleAADPrefix + accountID }

// Save records a new sign-in: the refresh token sealed and bound to accountID.
func (s *GoogleStore) Save(ctx context.Context, accountID, refreshToken string) error {
	if accountID == "" || refreshToken == "" {
		return errors.New("a Google sign-in needs an account id and a refresh token")
	}
	box, err := s.rs.getBox(ctx, true, false)
	if err != nil {
		return err
	}
	env, err := box.Seal(googleAAD(accountID), []byte(refreshToken))
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO google_connection (id, account_id, refresh_token, state, connected_at) VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, refresh_token = excluded.refresh_token, state = excluded.state, connected_at = excluded.connected_at`,
		accountID, env, GoogleStateConnected, nowUTC())
	return err
}

// RefreshToken returns the decrypted refresh token, for a token call only: keep it in a local variable, never on a struct, in a log or in an error.
func (s *GoogleStore) RefreshToken(ctx context.Context) (string, error) {
	var r struct {
		Account sql.NullString `db:"account_id"`
		Token   sql.NullString `db:"refresh_token"`
	}
	err := s.db.GetContext(ctx, &r, "SELECT account_id, refresh_token FROM google_connection WHERE id = 1")
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (!r.Token.Valid || !r.Account.Valid)) {
		return "", ErrNoGoogleConnection
	}
	if err != nil {
		return "", err
	}
	box, err := s.rs.getBox(ctx, false, false)
	if err != nil {
		return "", err
	}
	pt, err := box.Open(googleAAD(r.Account.String), r.Token.String)
	if err != nil {
		return "", unreadable(err)
	}
	tok := string(pt)
	secretbox.Zero(pt)
	return tok, nil
}

// Get returns the sign-in without its token. With no row yet it reports not connected.
func (s *GoogleStore) Get(ctx context.Context) (*GoogleConnection, error) {
	var r struct {
		Account sql.NullString `db:"account_id"`
		Token   sql.NullString `db:"refresh_token"`
		State   string         `db:"state"`
		At      sql.NullString `db:"connected_at"`
	}
	err := s.db.GetContext(ctx, &r, "SELECT account_id, refresh_token, state, connected_at FROM google_connection WHERE id = 1")
	if errors.Is(err, sql.ErrNoRows) {
		return &GoogleConnection{State: GoogleStateDisconnected}, nil
	}
	if err != nil {
		return nil, err
	}
	return &GoogleConnection{AccountID: r.Account.String, State: r.State, ConnectedAt: r.At.String, Connected: r.Token.Valid && r.Account.Valid}, nil
}

// SetState records a state (reconnect, when Google refuses the token). Only the state constants are accepted.
func (s *GoogleStore) SetState(ctx context.Context, state string) error {
	switch state {
	case GoogleStateDisconnected, GoogleStateConnected, GoogleStateReconnect:
	default:
		return errors.New("not a Google connection state")
	}
	_, err := s.db.ExecContext(ctx, "UPDATE google_connection SET state = ? WHERE id = 1", state)
	return err
}

// Disconnect forgets the token and the account.
func (s *GoogleStore) Disconnect(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "UPDATE google_connection SET refresh_token = NULL, account_id = NULL, state = ?, connected_at = NULL WHERE id = 1", GoogleStateDisconnected)
	return err
}
