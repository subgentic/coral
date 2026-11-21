package devicekey

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/store"
)

// Device signing step 4(b) (#20513, coral-hub #260094, version 3 of the signed text). A relayed kind is a request the Hub carries from a person's signed-in device to this computer: a send to an agent, a board post, a roster or a
// grant. Each carries a body, and the signature covers that body by hash, so the Hub (or anything between) cannot keep the signature and swap the words. The four step-2 actions are not touched: they keep the v2 label and their bytes.

// Kind is a relayed kind. Every kind signs one text of one shape: a kind with no body (grant-member, input-grant, keep-full-access, hub-auto-accept) signs the hash of the empty body, and what it acts on is in the signed path.
type Kind string

const (
	GuideRoster             Kind = "guide-roster"
	GrantMember             Kind = "grant-member"
	InputGrant              Kind = "input-grant"
	KeepFullAccess          Kind = "keep-full-access"
	HubAutoAccept           Kind = "hub-auto-accept"
	OrchestratorGrant       Kind = "orchestrator-grant"
	TrustPreview            Kind = "trust-preview"
	DailyKnowledgeTeam      Kind = "daily-knowledge-team"
	DailyKnowledgeAutoApply Kind = "daily-knowledge-auto-apply"
	DailyKnowledgeAccept    Kind = "daily-knowledge-accept"
	DailyKnowledgeRevert    Kind = "daily-knowledge-revert"
	SendToAgent             Kind = "send-to-agent"
	BoardPost               Kind = "board-post"
)

// RelayedKinds is every relayed kind.
var RelayedKinds = []Kind{GuideRoster, GrantMember, InputGrant, KeepFullAccess, HubAutoAccept, OrchestratorGrant, TrustPreview, DailyKnowledgeTeam, DailyKnowledgeAutoApply, DailyKnowledgeAccept, DailyKnowledgeRevert, SendToAgent, BoardPost}

// relayedLabel starts every v3 signing input, so a v3 signature is never a v2 one and the reverse.
const relayedLabel = "coral-hub/device-keys/3/"

// RequestTarget is the one string a relayed request is signed and compared by: the request URI exactly as this computer received it, the path as sent and the query as sent, with nothing reordered, decoded or re-encoded. Through
// the Hub the browser calls /api/remote/<server>/api/...: the tunnel strips /api/remote/<server>, so the request this computer sees starts at /api/, and that stripped form is what is signed.
func RequestTarget(r *http.Request) string { return r.URL.RequestURI() }

// RelayedBodyMax is the most body bytes a relayed request may carry: the hash is of the exact received bytes, so the computer reads at most this many before it hashes.
const RelayedBodyMax = 1 << 20

// relayedWindow is the one window of every relayed kind: five minutes.
const relayedWindow = 5 * time.Minute

// ErrBodyHash is code body_hash: the body that arrived is not the one whose SHA-256 the signer signed. It never carries either.
var ErrBodyHash = errors.New("body_hash")

// ErrBodyTooLarge is code body_too_large: the body is over RelayedBodyMax.
var ErrBodyTooLarge = errors.New("body_too_large")

// ErrWrongRequest is code wrong_request: the method or the path in the signed text is not the one the computer received.
var ErrWrongRequest = errors.New("wrong_request")

// ErrWrongLink is code wrong_link: the message arrived on another link than the one it names or than its signer's, or a key with a link came in on none.
var ErrWrongLink = errors.New("wrong_link")

// ErrOutsidePair is code outside_pair: the message acts on, or is made for, another (link, Hub label) pair than its signer's.
var ErrOutsidePair = errors.New("outside_pair")

// ErrNoAuthority is returned when HandleRelayed is called without the function that decides what the signer may do: a signature alone is never enough.
var ErrNoAuthority = errors.New("no_authority")

// Relayed is one signed v3 message, as parsed.
type Relayed struct {
	Kind       Kind
	KID        string // the signer, 43 chars
	Computer   string // this computer's fingerprint, 43 chars
	Ts         int64  // unix seconds
	Nonce      string // 16 random bytes, 22 chars
	Link       string // the Hub link the request came through, 1 to 64 of A-Z a-z 0-9 _ -
	HubUser    string // hub-user- and 8 to 16 lower-case hex, an even count
	Method     string // the HTTP method the Hub relays: GET, POST, PUT, PATCH or DELETE
	Path       string // the request URI exactly as the computer received it: path and query, from /api/, printable ASCII, at most 512 bytes
	BodySHA256 string // lower-case hex SHA-256 of the exact body bytes, 64 chars
}

// relayedKeys is the one order of every v3 body.
var relayedKeys = []string{"kid", "computer", "ts", "nonce", "link", "hub_user", "method", "path", "body_sha256"}

// BodySHA256 is the lower-case hex SHA-256 of the exact body bytes, as the signed text carries it.
func BodySHA256(body []byte) string {
	s := sha256.Sum256(body)
	return hex.EncodeToString(s[:])
}

func relayedKnown(k Kind) bool {
	for _, x := range RelayedKinds {
		if x == k {
			return true
		}
	}
	return false
}

func lowerHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func linkOK(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func hubUserOK(s string) bool {
	const p = "hub-user-"
	if len(s) < len(p)+8 || len(s) > len(p)+16 || s[:len(p)] != p || (len(s)-len(p))%2 != 0 {
		return false
	}
	return lowerHex(s[len(p):], len(s)-len(p))
}

func methodOK(s string) bool {
	switch s {
	case "GET", "POST", "PUT", "PATCH", "DELETE":
		return true
	}
	return false
}

func pathOK(s string) bool {
	if len(s) < 6 || len(s) > 512 || s[:5] != "/api/" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func (m Relayed) validate() error {
	if !relayedKnown(m.Kind) {
		return ErrBadForm
	}
	if _, ok := fixedB64(m.KID, 43, 32); !ok {
		return ErrBadForm
	}
	if _, ok := fixedB64(m.Computer, 43, 32); !ok {
		return ErrBadForm
	}
	if _, ok := fixedB64(m.Nonce, 22, 16); !ok {
		return ErrBadForm
	}
	if m.Ts < 1 || m.Ts > 9_999_999_999_999_999 {
		return ErrBadForm
	}
	if !methodOK(m.Method) || !pathOK(m.Path) {
		return ErrBadForm
	}
	if !linkOK(m.Link) || !hubUserOK(m.HubUser) || !lowerHex(m.BodySHA256, 64) {
		return ErrBadForm
	}
	return nil
}

func (m *Relayed) strField(k string) *string {
	switch k {
	case "kid":
		return &m.KID
	case "computer":
		return &m.Computer
	case "nonce":
		return &m.Nonce
	case "link":
		return &m.Link
	case "hub_user":
		return &m.HubUser
	case "method":
		return &m.Method
	case "path":
		return &m.Path
	case "body_sha256":
		return &m.BodySHA256
	}
	return nil
}

// Canonical validates the message and returns its one byte form, built as the v2 bodies are: the keys in their fixed order, no spaces, the integer plain decimal.
func (m Relayed) Canonical() ([]byte, error) {
	if err := m.validate(); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range relayedKeys {
		if i > 0 {
			b.WriteByte(',')
		}
		jsonString(&b, k)
		b.WriteByte(':')
		if k == "ts" {
			b.WriteString(strconv.FormatInt(m.Ts, 10))
		} else {
			jsonString(&b, *m.strField(k))
		}
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// RelayedSigningInput is what the device key signs for a relayed kind: the v3 label, the kind, one zero byte, then the canonical text.
func RelayedSigningInput(k Kind, canonical []byte) []byte {
	out := make([]byte, 0, len(relayedLabel)+len(k)+1+len(canonical))
	out = append(out, relayedLabel...)
	out = append(out, k...)
	out = append(out, 0)
	return append(out, canonical...)
}

// ParseRelayed reads a v3 text strictly, as Parse reads a v2 one: exactly the keys in order, string values and a plain integer for ts, every field well formed, and the bytes equal to the canonical form rebuilt from them.
func ParseRelayed(k Kind, raw []byte) (Relayed, error) {
	if len(raw) == 0 || len(raw) > MaxBody || !utf8.Valid(raw) || !relayedKnown(k) {
		return Relayed{}, ErrBadForm
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return Relayed{}, ErrBadForm
	}
	m := Relayed{Kind: k}
	for _, want := range relayedKeys {
		kt, err := dec.Token()
		if key, ok := kt.(string); err != nil || !ok || key != want {
			return Relayed{}, ErrBadForm
		}
		vt, err := dec.Token()
		if err != nil {
			return Relayed{}, ErrBadForm
		}
		if want == "ts" {
			n, ok := vt.(json.Number)
			if !ok || !plainInt(string(n)) {
				return Relayed{}, ErrBadForm
			}
			m.Ts, _ = strconv.ParseInt(string(n), 10, 64)
			continue
		}
		s, ok := vt.(string)
		if !ok {
			return Relayed{}, ErrBadForm
		}
		*m.strField(want) = s
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return Relayed{}, ErrBadForm
	}
	if _, err := dec.Token(); err != io.EOF {
		return Relayed{}, ErrBadForm
	}
	canon, err := m.Canonical()
	if err != nil || !bytes.Equal(canon, raw) {
		return Relayed{}, ErrBadForm
	}
	return m, nil
}

// HandleRelayedOn verifies one relayed request and, only when every check has passed, spends its nonce. arrivedLink, method and path are what this computer itself received (the link from its own stamp, the request's method and
// URI): the signed text must equal them, and it must carry the signer's own pair. canonical is the signed text, body the exact bytes received, sig the P1363 signature. The order is the one Handle uses (cheap checks, the
// signature, then authority) with the body hash after the signature: a body that is not the signed one is refused as body_hash and spends nothing. authorize is required: it is given the parsed message and the signer's row
// from this computer's own list, before the nonce is spent, and decides what that signer may do for the kind (the per-kind checks, #20514); a refusal spends nothing.
func (v *Verifier) HandleRelayedOn(ctx context.Context, arrivedLink, method, path string, k Kind, canonical, body []byte, sig string, now time.Time, authorize func(Relayed, store.DeviceKey) error) (Relayed, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if authorize == nil {
		return Relayed{}, ErrNoAuthority
	}
	if v.Refuse != nil && v.Refuse() {
		return Relayed{}, ErrListUnavailable
	}
	if len(body) > RelayedBodyMax {
		return Relayed{}, ErrBodyTooLarge
	}
	m, err := ParseRelayed(k, canonical)
	if err != nil {
		return Relayed{}, err
	}
	if m.Computer != v.Computer {
		return Relayed{}, ErrWrongComputer
	}
	if m.Method != method || m.Path != path {
		return Relayed{}, ErrWrongRequest
	}
	if m.Link != arrivedLink {
		return Relayed{}, ErrWrongLink
	}
	ts := time.Unix(m.Ts, 0)
	if ts.Before(now.Add(-relayedWindow)) || ts.After(now.Add(aheadSkew)) {
		return Relayed{}, ErrTsWindow
	}
	if !v.RefuseBefore.IsZero() && ts.Before(v.RefuseBefore) {
		return Relayed{}, ErrBeforeStart
	}
	if err := v.Store.CheckClock(ctx, now); err != nil {
		return Relayed{}, mapStoreErr(err)
	}
	signer, err := v.Store.ActiveDeviceKey(ctx, m.KID, now)
	if err != nil {
		return Relayed{}, mapStoreErr(err)
	}
	if signer.Kind != store.DeviceKindDevice {
		return Relayed{}, ErrUnknownSigner
	}
	if !verifyP1363(signer.PK, RelayedSigningInput(k, canonical), sig) {
		return Relayed{}, ErrBadSignature
	}
	// The signature is good, so what it covers is the signer's. The body must be exactly what it names, and the pair in it the signer's own.
	if subtle.ConstantTimeCompare([]byte(BodySHA256(body)), []byte(m.BodySHA256)) != 1 {
		return Relayed{}, ErrBodyHash
	}
	owner, bound := signer.PairState()
	if !owner && !bound { // a pair that is missing or half a marker fails closed
		return Relayed{}, ErrOutsidePair
	}
	if bound && m.Link != signer.Link {
		return Relayed{}, ErrWrongLink
	}
	if bound && m.HubUser != signer.HubUser {
		return Relayed{}, ErrOutsidePair
	}
	if err := v.Store.NonceSeen(ctx, m.Nonce, now); err != nil {
		return Relayed{}, mapStoreErr(err)
	}
	if err := authorize(m, signer); err != nil {
		return Relayed{}, err
	}
	if err := v.Store.RecordNonce(ctx, m.Nonce, m.KID, now, relayedWindow); err != nil {
		return Relayed{}, mapStoreErr(err)
	}
	if err := v.Store.TouchDeviceKey(ctx, m.KID, now); err != nil {
		return Relayed{}, err
	}
	return m, nil
}
