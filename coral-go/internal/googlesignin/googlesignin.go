// Package googlesignin is Coral's one client for the Google sign-in behind Google Doc share (#20022), built like internal/dropbox: OAuth 2 authorization code with
// PKCE S256 on a one-shot loopback listener, an offline refresh token for the sealed store, refresh, and revoke. Unlike Dropbox's, Google's client has a client_secret:
// it is read at run time from the file the owner named (LoadClientFile), held in memory, and never printed, logged, put in an error, sent anywhere but Google's token
// endpoint, or kept in a fixture or a binary. Every request goes through one HTTP client that talks only to Google's two hosts over TLS and never follows a redirect.
// Errors carry Google's error tag only, never its description or body, and never a token, a code or the client's text.
package googlesignin

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
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Errors a caller tells apart.
var (
	// ErrHostNotAllowed: a request to anything but Google's two hosts over https was refused before it was sent.
	ErrHostNotAllowed = errors.New("not a Google API host")
	// ErrInvalidGrant: Google answered invalid_grant, so the sign-in is revoked or expired and the person must connect again. Any other failure (offline, a 5xx)
	// is not this one, and a caller keeps the sign-in.
	ErrInvalidGrant = errors.New("Google no longer accepts this sign-in")
	// ErrClientFile is every problem with the client file, in one fixed sentence: it never echoes the file's text or the path's reason.
	ErrClientFile = errors.New("the Google client file could not be read: it must be the OAuth client JSON Google gives for a desktop app")
	// ErrScope: Google granted something other than the one scope asked for.
	ErrScope = errors.New("Google granted a different access than Coral asked for")
)

// Scope is the one scope Coral asks for: files Coral itself made or the person opened with it.
const Scope = "https://www.googleapis.com/auth/drive.file"

const (
	authorizeURL  = "https://accounts.google.com/o/oauth2/v2/auth" // opened in the person's browser, never fetched by Coral
	tokenBase     = "https://oauth2.googleapis.com"
	apiBase       = "https://www.googleapis.com"
	maxBody       = 1 << 20
	maxClientFile = 64 << 10
)

var googleHosts = map[string]bool{"oauth2.googleapis.com": true, "www.googleapis.com": true}

// ClientCreds is the OAuth client, read from the file at run time.
type ClientCreds struct {
	ID, Secret string
}

// String never prints the secret (a stray %v or log line cannot leak it).
func (c ClientCreds) String() string { return "googlesignin.ClientCreds{}" }

// GoString is String for %#v.
func (c ClientCreds) GoString() string { return c.String() }

// LoadClientFile reads Google's "installed" (or "web") client JSON from path. Any problem is ErrClientFile, with nothing of the file in it.
func LoadClientFile(path string) (ClientCreds, error) {
	if path == "" {
		return ClientCreds{}, ErrClientFile
	}
	f, err := os.Open(path)
	if err != nil {
		return ClientCreds{}, ErrClientFile
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxClientFile+1))
	if err != nil || len(data) > maxClientFile {
		return ClientCreds{}, ErrClientFile
	}
	var raw struct {
		Installed *struct {
			ID     string `json:"client_id"`
			Secret string `json:"client_secret"`
		} `json:"installed"`
		Web *struct {
			ID     string `json:"client_id"`
			Secret string `json:"client_secret"`
		} `json:"web"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return ClientCreds{}, ErrClientFile
	}
	switch {
	case raw.Installed != nil && raw.Installed.ID != "" && raw.Installed.Secret != "":
		return ClientCreds{ID: raw.Installed.ID, Secret: raw.Installed.Secret}, nil
	case raw.Web != nil && raw.Web.ID != "" && raw.Web.Secret != "":
		return ClientCreds{ID: raw.Web.ID, Secret: raw.Web.Secret}, nil
	}
	return ClientCreds{}, ErrClientFile
}

// Token is what a sign-in gives: the refresh token is for the sealed store only; the access token lives in memory.
type Token struct {
	Access    string
	Refresh   string
	ExpiresIn int
}

// Client talks to Google.
type Client struct {
	creds     ClientCreds
	token     string // the token endpoint's base
	api       string
	hc        *http.Client
	userAgent string
}

// NewClient is the client for the real Google.
func NewClient(creds ClientCreds) *Client {
	return newClient(creds, tokenBase, apiBase, func(host string) bool { return googleHosts[host] })
}

// NewClientAt is a client for a test Google at base (an http://127.0.0.1 URL only: anything else panics), for tests outside this package.
func NewClientAt(creds ClientCreds, base string) *Client {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		panic("googlesignin.NewClientAt is for a local test server only")
	}
	return newClient(creds, base, base, func(host string) bool { return host == u.Host })
}

func newClient(creds ClientCreds, token, api string, allow func(string) bool) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	tr.Proxy = http.ProxyFromEnvironment
	tr.ResponseHeaderTimeout = 30 * time.Second
	hc := &http.Client{
		Timeout:       2 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     hostGate{next: tr, allow: allow, httpsOnly: strings.HasPrefix(token, "https://")},
	}
	return &Client{creds: creds, token: token, api: api, hc: hc, userAgent: "Coral"}
}

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

func (c *Client) tokenCall(ctx context.Context, form url.Values) (Token, string, error) {
	form.Set("client_id", c.creds.ID)
	form.Set("client_secret", c.creds.Secret) // only to Google's token endpoint
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.token+"/token", strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, "", errors.New("could not build the Google request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.hc.Do(req)
	if err != nil {
		return Token{}, "", fmt.Errorf("could not reach Google: %w", stripURL(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error == "invalid_grant" {
			return Token{}, "", ErrInvalidGrant
		}
		tag := e.Error
		if !validTag(tag) {
			tag = "unknown"
		}
		return Token{}, "", fmt.Errorf("Google token endpoint: %d %s", resp.StatusCode, tag)
	}
	var t struct {
		Access    string `json:"access_token"`
		Refresh   string `json:"refresh_token"`
		ExpiresIn int    `json:"expires_in"`
		Scope     string `json:"scope"`
	}
	if err := json.Unmarshal(data, &t); err != nil || t.Access == "" {
		return Token{}, "", errors.New("Google token endpoint: an answer Coral does not understand")
	}
	return Token{Access: t.Access, Refresh: t.Refresh, ExpiresIn: t.ExpiresIn}, t.Scope, nil
}

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

func stripURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// Exchange trades an authorization code and its PKCE verifier for a token, and checks that the one scope asked for is the one granted. The redirect must be
// the one the sign-in started with.
func (c *Client) Exchange(ctx context.Context, code, verifier, redirect string) (Token, error) {
	t, scope, err := c.tokenCall(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {redirect}})
	if err != nil {
		return Token{}, err
	}
	if fs := strings.Fields(scope); len(fs) != 1 || fs[0] != Scope {
		return Token{}, ErrScope
	}
	return t, nil
}

// Refresh trades the refresh token for a new access token. ErrInvalidGrant means connect again; any other error leaves the sign-in as it is.
func (c *Client) Refresh(ctx context.Context, refresh string) (string, time.Duration, error) {
	t, _, err := c.tokenCall(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if err != nil {
		return "", 0, err
	}
	return t.Access, time.Duration(t.ExpiresIn) * time.Second, nil
}

// AccountID is the signed-in account's stable id (Drive's permissionId), read with the access token. No name or address is asked for or kept.
func (c *Client) AccountID(ctx context.Context, access string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.api+"/drive/v3/about?fields=user(permissionId)", nil)
	if err != nil {
		return "", errors.New("could not build the Google request")
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach Google: %w", stripURL(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	var a struct {
		User struct {
			ID string `json:"permissionId"`
		} `json:"user"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(data, &a) != nil || a.User.ID == "" {
		return "", fmt.Errorf("Google account lookup: %d", resp.StatusCode)
	}
	return a.User.ID, nil
}

// Revoke ends the sign-in at Google: the refresh token (and with it the access tokens made from it). Best effort: the caller forgets the token here whatever this says.
func (c *Client) Revoke(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.token+"/revoke", strings.NewReader(url.Values{"token": {token}}.Encode()))
	if err != nil {
		return errors.New("could not build the Google request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach Google: %w", stripURL(err))
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBody))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusBadRequest { // 400: already revoked or expired
		return fmt.Errorf("Google revoke: %d", resp.StatusCode)
	}
	return nil
}

// FlowTTL is how long a started sign-in waits for its callback.
const FlowTTL = 5 * time.Minute

// Flows holds the one pending sign-in: the state (kept as a hash), the browser binding (a hash) and the PKCE verifier, in memory only. A new sign-in replaces a
// pending one; a state is taken once, compared in constant time, and expires after FlowTTL.
type Flows struct {
	mu          sync.Mutex
	stateHash   [32]byte
	bindingHash [32]byte
	verifier    string
	redirect    string
	created     time.Time
	pending     bool
	now         func() time.Time
}

var callbackRe = regexp.MustCompile(`^http://127\.0\.0\.1:[0-9]{2,5}/google/callback$`)

// NewFlows makes an empty holder.
func NewFlows() *Flows { return &Flows{now: time.Now} }

func random32() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Start begins a sign-in bound to the browser that asked (binding: the flow cookie's value) and returns the URL to open in that browser. Only the verifier's S256
// challenge goes in the URL. redirect must be the loopback callback.
func (f *Flows) Start(clientID, redirect, binding string) (string, error) {
	if !callbackRe.MatchString(redirect) {
		return "", errors.New("a Google sign-in only returns to Coral's callback on 127.0.0.1")
	}
	if binding == "" {
		return "", errors.New("a Google sign-in must be bound to the browser that started it")
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
		"client_id": {clientID}, "response_type": {"code"}, "redirect_uri": {redirect}, "scope": {Scope},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"access_type": {"offline"}, "prompt": {"consent"}, "state": {state},
	}
	return authorizeURL + "?" + q.Encode(), nil
}

// Take returns the pending sign-in's verifier and redirect when state is its state, binding is the browser that started it, and it has not expired. A match
// consumes it; a wrong state or browser does not (so a guess cannot cancel the person's sign-in).
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
	if subtle.ConstantTimeCompare(h[:], f.stateHash[:]) != 1 || subtle.ConstantTimeCompare(b[:], f.bindingHash[:]) != 1 || binding == "" {
		return "", "", false
	}
	verifier, redirect = f.verifier, f.redirect
	f.clear()
	return verifier, redirect, true
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
