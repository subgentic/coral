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
	minted map[string]mintedCredential // label -> what the Hub answered with, so a failed launch can revoke it (Revoke)

	BaseURL      string       // the Hub's origin (https; plain http only for a loopback address, for tests)
	Key          string       // the chk_ automation key (from a 0600 file, memory only)
	TermsVersion string       // the terms version the person accepted when the key was made; the Hub checks it
	HTTP         *http.Client // nil: a client with a 30 second timeout that follows no redirect
	// RevokeEvery is the pause between tries of a revoke the Hub answered 429 or 503 to (0: 2 seconds).
	RevokeEvery time.Duration
}

// mintedCredential is what the Hub's mint answer says about the credential's identity: its id, and the destroy credential (chd_) that revokes it. ASSUMED shape (coral-hub's note, relayed on the board): "id" and
// "destroy_credential" in the mint answer; a Hub that does not send them leaves the credential unrevocable from here, and a failed launch says so.
type mintedCredential struct{ ID, Destroy string }

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
		return "Coral Hub says too many credentials were made just now: wait a few minutes and run this again"
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
	body, _ := json.Marshal(struct {
		Adapter       string `json:"adapter"`
		ProviderScope string `json:"provider_scope"`
		Label         string `json:"label"`
		Persistence   string `json:"persistence"`
		TTLMinutes    int    `json:"ttl_minutes"`
		AcceptTerms   string `json:"accept_terms"`
	}{"generic", "digitalocean", label, "ephemeral", 5, h.TermsVersion})
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
		ID         string `json:"id"`
		Destroy    string `json:"destroy_credential"`
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
	h.minted[label] = mintedCredential{ID: answer.ID, Destroy: answer.Destroy}
	h.mu.Unlock()
	return answer.Credential, nil
}

var (
	credentialIDShape = regexp.MustCompile(`^[0-9a-fA-F-]{32,40}$`)
	destroyShape      = regexp.MustCompile(`^chd_[A-Za-z0-9_\-]{8,500}$`)
)

// ErrNothingToRevoke is a Revoke for a label this client never minted a revocable credential for.
var ErrNothingToRevoke = errors.New("this launch has no revocable credential (the Hub did not send its id and destroy credential)")

// Revoke revokes the credential minted for label: POST /api/bootstrap/credentials/{id}/revoke with the destroy credential (chd_) as the one Bearer header, no body, no Origin. It ends the identity enrolled from the
// credential, or expires it if it was never redeemed; an already ended one is also a success (the Hub's route is idempotent). 429 and 503 are tried again a few times (they may pass); anything else is an error that
// holds the status only. ASSUMED from coral-hub's description of the route (board, 09:50 and its 09:54 corrections), until Lead's HubRevoker (#10918) replaces it.
func (h *HubClient) Revoke(ctx context.Context, label string) error {
	h.mu.Lock()
	m, ok := h.minted[label]
	h.mu.Unlock()
	if !ok || !credentialIDShape.MatchString(m.ID) || !destroyShape.MatchString(m.Destroy) {
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
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/"+m.ID+"/revoke", nil)
		if err != nil {
			return errors.New("could not make the revoke request to Coral Hub")
		}
		req.Header.Set("Authorization", "Bearer "+m.Destroy)
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
