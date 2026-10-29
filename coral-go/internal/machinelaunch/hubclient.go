package machinelaunch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Minter asks Coral Hub for one machine credential.
type Minter interface {
	// Mint returns a single-use machine credential (chb_...) whose label is the machine's name. The credential is the one secret that goes into the instance's user-data.
	Mint(ctx context.Context, label string) (string, error)
}

// HubClient mints machine credentials with the person's Coral Hub automation key (the joint note with coral-hub, #9934): POST /api/bootstrap/credentials with the key as a Bearer token. The key can
// only mint credentials for its own account and only for the adapters ticked when it was made; it reads and lists nothing. It never follows a redirect (the key must not travel to another host).
type HubClient struct {
	mu     sync.Mutex
	minted map[string]mintedCredential // label -> what the Hub answered with, so a failed launch can revoke it (Revoke) and say when it expires (ExpiresAt)

	BaseURL string // the Hub's origin (https; plain http only for a loopback address, for tests)
	Key     string // the chk_ automation key (from a 0600 file, memory only)
	// DestroyKey is the automation key's chd_ (from the optional 0600 --hub-destroy-file, memory only): the one credential that revokes what the key minted. It is never in a mint answer. "" means a launch that fails
	// after the mint cannot revoke the credential, and says so.
	DestroyKey   string
	TermsVersion string       // the terms version the person accepted when the key was made; the Hub checks it
	HTTP         *http.Client // nil: a client with a 30 second timeout that follows no redirect
	// RevokeEvery is the pause between tries of a revoke the Hub answered 429 or 503 to (0: 2 seconds).
	RevokeEvery time.Duration
}

var (
	keyShape     = regexp.MustCompile(`^chk_[A-Za-z0-9_\-]{8,200}$`)
	credShape    = regexp.MustCompile(`^chb_[A-Za-z0-9_\-]{8,500}$`)
	errorWord    = regexp.MustCompile(`^[a-z][a-z_]{0,39}$`)
	labelShape   = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62})$`)
	maxHubAnswer = int64(64 << 10)
)

// HubError is a refusal or failure from the Hub, said in this tool's words: it holds the status and (when the Hub sent a plain error word) the word, never the body and never the key.
type HubError struct {
	Status int
	Code   string
}

func (e *HubError) Error() string {
	switch {
	case e.Status == 0:
		return "could not reach Coral Hub"
	case e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden:
		return "Coral Hub did not accept the key (it may be wrong, expired, or not allowed to make machine credentials): make a new key in Coral Hub"
	case e.Status == http.StatusConflict && e.Code == "terms_reconsent_required":
		return "Coral Hub needs the current terms accepted again: accept them in Coral Hub, then run this again"
	case e.Status == http.StatusTooManyRequests:
		return "Coral Hub says too many credentials were made just now (30 a minute for an account): wait a minute and run this again"
	case e.Status == http.StatusConflict && e.Code == "live_limit_reached":
		return "Coral Hub says this account has as many machine credentials outstanding as it may (5 for this kind): delete or approve a pending machine, or wait for one to expire, then run this again"
	case e.Status == http.StatusConflict && e.Code == "adapter_capacity_reached":
		return "Coral Hub says it cannot take another machine of this kind right now: run this again later, or ask coral-hub; this is not retried"
	case e.Code != "":
		return fmt.Sprintf("Coral Hub refused the request (HTTP %d, %s)", e.Status, e.Code)
	}
	return fmt.Sprintf("Coral Hub refused the request (HTTP %d)", e.Status)
}

func (h *HubClient) endpoint() (string, error) {
	u, err := url.Parse(strings.TrimSpace(h.BaseURL))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("the Coral Hub address must be an origin such as https://app.coralhub.dev")
	}
	if u.Scheme != "https" {
		host := u.Hostname()
		ip := net.ParseIP(host)
		if u.Scheme != "http" || !(host == "localhost" || (ip != nil && ip.IsLoopback())) {
			return "", errors.New("the Coral Hub address must be https")
		}
	}
	return u.Scheme + "://" + u.Host + "/api/bootstrap/credentials", nil
}

// Mint makes the request described in the joint note: generic adapter, scope digitalocean, the machine's name as the label, ephemeral, 5 minutes.
func (h *HubClient) Mint(ctx context.Context, label string) (string, error) {
	if !keyShape.MatchString(h.Key) {
		return "", errors.New("the Coral Hub key does not look like one (it starts with chk_): check the key file")
	}
	if !labelShape.MatchString(label) {
		return "", errors.New("the machine name must be 1 to 63 of a-z, 0-9 and hyphen, not starting with a hyphen")
	}
	endpoint, err := h.endpoint()
	if err != nil {
		return "", err
	}
	// A droplet mints as the "generic" (bearer-only) adapter: provider_scope is for aws and gcp and a 400 for the others, and external_id only for persistent bearer-only machines, which these are not. ttl_minutes is 1 to 5.
	body, _ := json.Marshal(struct {
		Adapter     string `json:"adapter"`
		Label       string `json:"label"`
		Persistence string `json:"persistence"`
		TTLMinutes  int    `json:"ttl_minutes"`
		AcceptTerms string `json:"accept_terms"`
	}{"generic", label, "ephemeral", 5, h.TermsVersion})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", errors.New("could not make the request to Coral Hub")
	}
	req.Header.Set("Authorization", "Bearer "+h.Key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "coral-machine-launch")
	client := h.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse } // the key goes to this host and no other
	resp, err := c.Do(req)
	if err != nil {
		return "", &HubError{} // the error text of a transport failure may hold the URL: it is dropped
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxHubAnswer))
	var answer struct {
		Credential string `json:"credential"`
		ID         string `json:"credential_id"` // the credential's id (a UUID): what the revoke names
		ExpiresAt  string `json:"expires_at"`
		Error      string `json:"error"`
	}
	_ = json.Unmarshal(raw, &answer)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		code := ""
		if errorWord.MatchString(answer.Error) {
			code = answer.Error
		}
		return "", &HubError{Status: resp.StatusCode, Code: code}
	}
	if !credShape.MatchString(answer.Credential) {
		return "", errors.New("Coral Hub's answer did not carry a machine credential this tool understands")
	}
	h.mu.Lock()
	if h.minted == nil {
		h.minted = map[string]mintedCredential{}
	}
	exp, _ := time.Parse(time.RFC3339, answer.ExpiresAt)
	h.minted[label] = mintedCredential{ID: answer.ID, Expires: exp}
	h.mu.Unlock()
	return answer.Credential, nil
}

var (
	credentialIDShape = regexp.MustCompile(`^[0-9a-fA-F-]{32,40}$`)
	destroyShape      = regexp.MustCompile(`^chd_[A-Za-z0-9_\-]{8,500}$`)
)

// mintedCredential is what the mint answer says about the credential: its id (a UUID) and when it expires.
type mintedCredential struct {
	ID      string
	Expires time.Time
}

// ExpiresAt is when the credential minted for label expires, from the Hub's own answer (never a fixed number of minutes), and whether it said.
func (h *HubClient) ExpiresAt(label string) (time.Time, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m, ok := h.minted[label]
	return m.Expires, ok && !m.Expires.IsZero()
}

// Errors a revoke answers with before it asks the Hub anything.
var (
	// ErrNothingToRevoke is a Revoke for a label this client never minted a credential with an id for.
	ErrNothingToRevoke = errors.New("this launch has no credential id to revoke (the Hub did not send one)")
	// ErrNoDestroyKey is a Revoke with no chd_ to revoke with: pass --hub-destroy-file next time, or revoke the machine in Coral Hub.
	ErrNoDestroyKey = errors.New("no destroy credential was given (--hub-destroy-file), so it cannot be revoked from here")
)

// Revoke revokes the credential minted for label: POST /api/bootstrap/credentials/{credential_id}/revoke with the automation key's destroy credential (chd_, DestroyKey) as the one Bearer header, no body, no Origin.
// It ends the identity enrolled from the credential, or expires it if it was never redeemed; an already ended one is also a success (the Hub's route is idempotent). 429 and 503 are tried again a few times (they
// may pass); anything else is an error that holds the status only. From coral-hub's description of the route and of the mint answer (board, 09:50, 09:54, 10:00).
func (h *HubClient) Revoke(ctx context.Context, label string) error {
	if !destroyShape.MatchString(h.DestroyKey) {
		return ErrNoDestroyKey
	}
	h.mu.Lock()
	m, ok := h.minted[label]
	id := m.ID
	h.mu.Unlock()
	if !ok || !credentialIDShape.MatchString(id) {
		return ErrNothingToRevoke
	}
	base, err := h.endpoint()
	if err != nil {
		return err
	}
	every := h.RevokeEvery
	if every <= 0 {
		every = 2 * time.Second
	}
	client := h.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var last *RevokeError
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/"+id+"/revoke", nil)
		if err != nil {
			return errors.New("could not make the revoke request to Coral Hub")
		}
		req.Header.Set("Authorization", "Bearer "+h.DestroyKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "coral-machine-launch")
		resp, err := c.Do(req)
		if err != nil {
			last = &RevokeError{}
		} else {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxHubAnswer))
			resp.Body.Close()
			switch {
			case resp.StatusCode == http.StatusOK:
				return nil
			case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable:
				last = &RevokeError{Status: resp.StatusCode}
			default:
				return &RevokeError{Status: resp.StatusCode}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
	return last
}

// RevokeError is Coral Hub's answer to a revoke that did not succeed, in this tool's words: the status only, never the body and never the destroy credential.
type RevokeError struct{ Status int }

func (e *RevokeError) Error() string {
	if e.Status == 0 {
		return "could not reach Coral Hub to revoke it"
	}
	return fmt.Sprintf("Coral Hub did not revoke it (HTTP %d)", e.Status)
}
