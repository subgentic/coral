// Package hubowner is the signed owner stamp of the self-hosted hub (#11378, gap A): how a Coral that a hub reaches with its API key can tell that a request is from a PERSON signed in at the hub, so
// Approve, Request changes and the change-request send (which refuse a bare API key, because a script holds that) work through coral --hub.
//
// The hub signs a request it forwards when the person behind it is signed in at the hub (the hub's own identity layer decided that: a dashboard session, never an API key or an agent token). The remote
// verifies the stamp with a secret that only a human act put on it: the hub's own SSH session or the remote's own command line wrote a 0600 file, never an HTTP route an API key can call. The stamp binds
// the remote's id, a purpose, the method, the path and query as sent, the SHA-256 of the body, a time and a nonce, so it cannot be moved to another machine, route, body or moment.
//
// Threat model, in plain words (#11378, Security's notes):
//   - The remote's own agents are trusted at the level of the OS user Coral runs as. An agent that runs as that user can read the secret file, as it can read the API key file; the stamp does not stand
//     between an agent and the computer it runs on. What it stands between is the NETWORK: a script or another computer that holds the hub's API key.
//   - With sign-in off at the HUB, the hub's own local programs count as its owner (the identity layer calls this computer's same-origin browser a person), so they can have a decision signed. Sign-in at
//     the hub is what makes "the person signed in" mean one person.
//   - Replacing the secret is a person's act at the remote (coral hub-owner-secret, which refuses inside an agent's session). Every time the file is written or replaced the remote logs one warning and its
//     health answer carries the file's time, so a silent rotation shows.
//   - A stamp covers one request for one of two routes, for 30 seconds, once: a captured stamp is dead after that, after a restart of the remote, and for any other body, route, query or computer.

package hubowner

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Header is the request header that carries the stamp. Anything a browser sends under this name is dropped by the hub's header allowlist; the remote refuses it from any caller that is not the hub's key.
const Header = "X-Coral-Hub-Owner"

// Purpose is bound into every MAC: a stamp is for one purpose and no other use of the same secret can be mistaken for it.
const Purpose = "coral-hub-owner-v1"

// MaxBody is the largest body a stamp covers; a request with a bigger one is not stamped (and refused by the remote if it carries a stamp).
const MaxBody = 64 << 10

// Skew is how far a stamp's time may be from the remote's clock, either way.
const Skew = 30 * time.Second

// secretBytes is the length of a secret, hex-encoded in its file and on the wire between the hub and the human act.
const secretBytes = 32

// routes are the ONLY routes a stamp is made for or accepted on: the Operator's decisions that need a person. Keyed "METHOD pattern"; a {name} matches one segment.
var routes = []string{
	"POST /api/board/{project}/artifacts/{id}/review",
	"POST /api/artifacts/{id}/comments/{cid}/send",
}

// Routes lists the allowlist, for census tests on both sides.
func Routes() []string { return append([]string(nil), routes...) }

// Allowed reports whether a request is on the allowlist. path is the decoded path without its query.
func Allowed(method, path string) bool {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	for _, r := range routes {
		m, p, _ := strings.Cut(r, " ")
		if m != method {
			continue
		}
		ps := strings.Split(strings.Trim(p, "/"), "/")
		if len(ps) != len(segs) {
			continue
		}
		ok := true
		for i := range ps {
			if strings.HasPrefix(ps[i], "{") {
				ok = ok && segs[i] != ""
			} else {
				ok = ok && ps[i] == segs[i]
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// NewSecret makes a secret: 32 random bytes as 64 lower-case hex digits.
func NewSecret() (string, error) {
	b := make([]byte, secretBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ValidSecret reports whether s is a secret as NewSecret makes one.
func ValidSecret(s string) bool {
	if len(s) != secretBytes*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && s == strings.ToLower(s)
}

// ValidRemoteID is the id the hub knows the remote by (1 to 32 lower case letters, digits and dashes).
func ValidRemoteID(id string) bool {
	if id == "" || len(id) > 32 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// mac is the stamp's MAC over everything it binds.
func mac(secret, remoteID, method, target string, body []byte, ts int64, nonce string) []byte {
	bodySum := sha256.Sum256(body)
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "%s\n%s\n%s\n%s\n%d\n%s\n%s", Purpose, remoteID, method, target, ts, nonce, hex.EncodeToString(bodySum[:]))
	return m.Sum(nil)
}

// Target is the path and query as the remote will see them (the escaped path, a "?", the raw query; no "?" for an empty query), the one string the stamp binds.
func Target(u *url.URL) string {
	t := u.EscapedPath()
	if u.RawQuery != "" {
		t += "?" + u.RawQuery
	}
	return t
}

// Sign makes the stamp for a request: the header value "v1.<time>.<nonce>.<mac>". The caller has already decided the person is signed in and that the route is allowed.
func Sign(secret, remoteID, method, target string, body []byte, now time.Time) (string, error) {
	if !ValidSecret(secret) || !ValidRemoteID(remoteID) {
		return "", errors.New("hubowner: no secret or remote id to sign with")
	}
	if len(body) > MaxBody {
		return "", errors.New("hubowner: the body is too large to stamp")
	}
	n := make([]byte, 16)
	if _, err := rand.Read(n); err != nil {
		return "", err
	}
	nonce := hex.EncodeToString(n)
	ts := now.Unix()
	return "v1." + strconv.FormatInt(ts, 10) + "." + nonce + "." + hex.EncodeToString(mac(secret, remoteID, method, target, body, ts, nonce)), nil
}

// Verifier checks stamps on the remote. It remembers the nonces it has accepted (for twice the skew), refuses a stamp older than the process start, and holds the secret and the remote id the human act
// installed. The zero value accepts nothing.
type Verifier struct {
	Secret   string
	RemoteID string
	// Start is when this process started: a stamp made before it is refused, so a stamp captured before a restart is dead after it.
	Start time.Time
	// Now is the clock (a test pins it); nil is time.Now.
	Now func() time.Time

	mu   sync.Mutex
	seen map[string]time.Time
}

// Errors of Verify. The text is for the log; the remote answers every one the same way.
var (
	ErrNoSecret  = errors.New("hubowner: no secret installed")
	ErrMalformed = errors.New("hubowner: the stamp is malformed")
	ErrStale     = errors.New("hubowner: the stamp is too old, too new, or from before this process started")
	ErrReplay    = errors.New("hubowner: the stamp was already used")
	ErrRoute     = errors.New("hubowner: this route does not take a stamp")
	ErrBad       = errors.New("hubowner: the stamp does not match this request")
	ErrBody      = errors.New("hubowner: the body is too large for a stamp")
)

// Verify checks the header value value against the request as the remote received it: method, the decoded path (for the allowlist), the target (escaped path and query, as Target gives) and the body.
// It returns nil only for a stamp that was made for exactly this request, now, once.
func (v *Verifier) Verify(value, method, decodedPath, target string, body []byte) error {
	if !ValidSecret(v.Secret) || !ValidRemoteID(v.RemoteID) {
		return ErrNoSecret
	}
	if !Allowed(method, decodedPath) {
		return ErrRoute
	}
	if len(body) > MaxBody {
		return ErrBody
	}
	parts := strings.Split(value, ".")
	if len(parts) != 4 || parts[0] != "v1" || len(parts[2]) != 32 || len(parts[3]) != 64 {
		return ErrMalformed
	}
	ts, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || strconv.FormatInt(ts, 10) != parts[1] {
		return ErrMalformed
	}
	nonce := parts[2]
	if _, err := hex.DecodeString(nonce); err != nil || nonce != strings.ToLower(nonce) {
		return ErrMalformed
	}
	got, err := hex.DecodeString(parts[3])
	if err != nil {
		return ErrMalformed
	}
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	at := time.Unix(ts, 0)
	if d := now.Sub(at); d > Skew || d < -Skew || at.Before(v.Start.Truncate(time.Second)) {
		return ErrStale
	}
	if subtle.ConstantTimeCompare(got, mac(v.Secret, v.RemoteID, method, target, body, ts, nonce)) != 1 {
		return ErrBad
	}
	// only a stamp that verified is remembered, so a forger cannot fill the table; it is bounded by what the hub itself signs in two skews
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.seen == nil {
		v.seen = map[string]time.Time{}
	}
	for n, t := range v.seen {
		if now.Sub(t) > 2*Skew {
			delete(v.seen, n)
		}
	}
	if _, dup := v.seen[nonce]; dup {
		return ErrReplay
	}
	if len(v.seen) >= 4096 {
		return ErrReplay // more verified stamps than a person can make in a minute: refuse rather than grow
	}
	v.seen[nonce] = now
	return nil
}
