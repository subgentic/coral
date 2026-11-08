// Package dropbox is Coral's one client for Dropbox (#14609, Dropbox stage 3a; design v33 §4 and §9): the sign-in (OAuth 2 authorization code with PKCE,
// a public client with no secret, an offline refresh token), refresh, and revoke. Every request goes through one HTTP client that talks only to Dropbox's
// API hosts over TLS, never follows a redirect, and uses the OS proxy. Errors carry Dropbox's error tag only, never its description or body (Dropbox
// error text can carry paths), and never a token or a code.
package dropbox

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Errors a caller tells apart.
var (
	// ErrHostNotAllowed: a request to anything but Dropbox's API hosts over https was refused before it was sent.
	ErrHostNotAllowed = errors.New("not a Dropbox API host")
	// ErrInvalidGrant: Dropbox answered invalid_grant, so the sign-in is revoked or expired and the person must connect again. Any other failure (offline,
	// DNS, a 5xx) is not this one, and a caller keeps the sign-in.
	ErrInvalidGrant = errors.New("Dropbox no longer accepts this sign-in")
)

const (
	authorizeURL = "https://www.dropbox.com/oauth2/authorize" // opened in the person's browser, never fetched by Coral
	apiBase      = "https://api.dropboxapi.com"
	contentBase  = "https://content.dropboxapi.com"
	maxBody      = 1 << 20 // a token or RPC answer is small
)

// dropboxHosts are the only hosts the client talks to.
var dropboxHosts = map[string]bool{"api.dropboxapi.com": true, "content.dropboxapi.com": true, "api.dropbox.com": true}

func allowedHost(host string) bool { return dropboxHosts[host] }

// Token is what a sign-in gives: the refresh token is for the sealed store only; the access token lives in memory.
type Token struct {
	Access    string
	Refresh   string
	AccountID string
	ExpiresIn int
}

// Client talks to Dropbox.
type Client struct {
	appKey    string
	api       string
	content   string
	hc        *http.Client
	tokenURL  string
	userAgent string
}

// NewClient is the client for the real Dropbox, with the app key (a config value, never a secret).
func NewClient(appKey string) *Client {
	return newClient(appKey, apiBase, contentBase, func(host string) bool { return allowedHost(host) })
}

func newClient(appKey, api, content string, allow func(string) bool) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	tr.Proxy = http.ProxyFromEnvironment // the OS proxy, as the person set it
	tr.ResponseHeaderTimeout = 30 * time.Second
	real := strings.HasPrefix(api, "https://")
	hc := &http.Client{
		Timeout:       2 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, // never followed
		Transport:     hostGate{next: tr, allow: allow, httpsOnly: real},
	}
	return &Client{appKey: appKey, api: api, content: content, hc: hc, tokenURL: api + "/oauth2/token", userAgent: "Coral"}
}

// hostGate refuses a request to any host the client is not for, before it is sent.
type hostGate struct {
	next      http.RoundTripper
	allow     func(string) bool
	httpsOnly bool
}

func (g hostGate) RoundTrip(r *http.Request) (*http.Response, error) {
	if !g.allow(r.URL.Host) || (g.httpsOnly && r.URL.Scheme != "https") {
		return nil, ErrHostNotAllowed
	}
	return g.next.RoundTrip(r)
}

// tokenError is Dropbox's token-endpoint error, of which only the tag is kept.
type tokenError struct {
	Error string `json:"error"`
}

func (c *Client) tokenCall(ctx context.Context, form url.Values) (Token, error) {
	form.Set("client_id", c.appKey) // a public client: no client_secret
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.hc.Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("could not reach Dropbox: %w", stripURL(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if resp.StatusCode != http.StatusOK {
		var e tokenError
		_ = json.Unmarshal(data, &e)
		if e.Error == "invalid_grant" {
			return Token{}, ErrInvalidGrant
		}
		tag := e.Error
		if !validTag(tag) {
			tag = "unknown"
		}
		return Token{}, fmt.Errorf("Dropbox token endpoint: %d %s", resp.StatusCode, tag)
	}
	var t struct {
		Access    string `json:"access_token"`
		Refresh   string `json:"refresh_token"`
		AccountID string `json:"account_id"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &t); err != nil || t.Access == "" {
		return Token{}, errors.New("Dropbox token endpoint: an answer Coral does not understand")
	}
	return Token{Access: t.Access, Refresh: t.Refresh, AccountID: t.AccountID, ExpiresIn: t.ExpiresIn}, nil
}

// validTag keeps an error tag only when it looks like one (lower case, digits, underscores, slashes): anything else could be text from the body.
func validTag(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '/' || r == '.') {
			return false
		}
	}
	return true
}

// stripURL drops the URL from a transport error (it could carry a query), keeping the cause.
func stripURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// Exchange trades an authorization code and its PKCE verifier for a token. The redirect must be the one the sign-in started with.
func (c *Client) Exchange(ctx context.Context, code, verifier, redirect string) (Token, error) {
	return c.tokenCall(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {redirect}})
}

// Refresh trades the refresh token for a new access token. ErrInvalidGrant means connect again; any other error leaves the sign-in as it is.
func (c *Client) Refresh(ctx context.Context, refresh string) (string, error) {
	t, err := c.tokenCall(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if err != nil {
		return "", err
	}
	return t.Access, nil
}

// Revoke ends the sign-in at Dropbox: the access token, and with it its refresh token.
func (c *Client) Revoke(ctx context.Context, access string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.api+"/2/auth/token/revoke", http.NoBody)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach Dropbox: %w", stripURL(err))
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBody))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized { // 401: already revoked
		return fmt.Errorf("Dropbox revoke: %d", resp.StatusCode)
	}
	return nil
}

// FlowTTL is how long a started sign-in waits for its callback.
const FlowTTL = 5 * time.Minute

// Flows holds the one pending sign-in: the state (kept as a hash) and the PKCE verifier, in memory only. A new sign-in replaces a pending one; a
// state is taken once, compared in constant time, and expires after FlowTTL.
type Flows struct {
	mu          sync.Mutex
	stateHash   [32]byte
	bindingHash [32]byte // the browser that started the sign-in (a flow cookie the start route set): only it can finish
	verifier    string
	redirect    string
	created     time.Time
	pending     bool
	now         func() time.Time
}

// callbackRe is the only redirect a sign-in may use: the one-shot listener on 127.0.0.1 (Security, #14619 note b).
var callbackRe = regexp.MustCompile(`^http://127\.0\.0\.1:[0-9]{2,5}/dropbox/callback$`)

// NewFlows makes an empty holder.
func NewFlows() *Flows { return &Flows{now: time.Now} }

func random32() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Start begins a sign-in bound to the browser that asked (binding: the value of the flow cookie the start route set) and returns the URL to open
// in that browser. The verifier stays here; only its S256 challenge goes in the URL. redirect must be the loopback callback.
func (f *Flows) Start(appKey, redirect, binding string) (string, error) {
	if !callbackRe.MatchString(redirect) {
		return "", errors.New("a Dropbox sign-in only returns to Coral's callback on 127.0.0.1")
	}
	if binding == "" {
		return "", errors.New("a Dropbox sign-in must be bound to the browser that started it")
	}
	state, err := random32()
	if err != nil {
		return "", err
	}
	verifier, err := random32()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	f.mu.Lock()
	f.stateHash, f.bindingHash, f.verifier, f.redirect, f.created, f.pending = sha256.Sum256([]byte(state)), sha256.Sum256([]byte(binding)), verifier, redirect, f.now(), true
	f.mu.Unlock()
	q := url.Values{
		"client_id": {appKey}, "response_type": {"code"}, "redirect_uri": {redirect},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"token_access_type": {"offline"}, "state": {state},
	}
	return authorizeURL + "?" + q.Encode(), nil
}

// Take returns the pending sign-in's verifier and the redirect captured at Start, when state is its state, binding is the browser that started it,
// and it has not expired. A match consumes it; a wrong state or browser does not (so a guess cannot cancel the person's sign-in).
func (f *Flows) Take(state, binding string) (verifier, redirect string, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.pending {
		return "", "", false
	}
	if f.now().Sub(f.created) > FlowTTL {
		f.clear()
		return "", "", false
	}
	h := sha256.Sum256([]byte(state))
	b := sha256.Sum256([]byte(binding))
	stateOK := subtle.ConstantTimeCompare(h[:], f.stateHash[:]) == 1
	bindOK := subtle.ConstantTimeCompare(b[:], f.bindingHash[:]) == 1
	if !stateOK || !bindOK || binding == "" {
		return "", "", false
	}
	verifier, redirect = f.verifier, f.redirect
	f.clear()
	return verifier, redirect, true
}

// Redirect is the pending sign-in's redirect URI (the token exchange must repeat it), or "".
func (f *Flows) Redirect() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.redirect
}

// Pending says whether a sign-in is waiting for its callback.
func (f *Flows) Pending() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pending && f.now().Sub(f.created) <= FlowTTL
}

func (f *Flows) clear() {
	f.pending, f.verifier, f.redirect, f.stateHash, f.bindingHash = false, "", "", [32]byte{}, [32]byte{}
}
