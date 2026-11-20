package gdocsync

// The sign-in for the live checks (#19953): the OAuth client and the refresh token live in the macOS keychain, never in a file, an environment variable, a log or an error.
// The keychain is written through `security -i` (the secret goes in on stdin, not on a command line another user's ps could read) and read with find-generic-password -w.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const keychainService = "coral-gdocsync"

// TokenURL is Google's token endpoint, used only to turn the stored refresh token into a short access token.
const TokenURL = "https://oauth2.googleapis.com/token"

// Creds is what the keychain holds for one sign-in.
type Creds struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RefreshToken string `json:"refresh_token"`
}

// StoreCreds saves the credentials under the account name (for example "full" or "file").
func StoreCreds(account string, c Creds) error {
	if strings.ContainsAny(account, " \t\n\"'\\") || account == "" {
		return errors.New("gdocsync: bad keychain account name")
	}
	b, _ := json.Marshal(c)
	cmd := exec.Command("security", "-i")
	cmd.Stdin = strings.NewReader(fmt.Sprintf("add-generic-password -U -a %s -s %s -w %s\n", account, keychainService, hex.EncodeToString(b)))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("gdocsync: the keychain write failed: %s", strings.TrimSpace(strings.ReplaceAll(string(out), hex.EncodeToString(b), "[secret]")))
	}
	return nil
}

// LoadCreds reads them back.
func LoadCreds(account string) (Creds, error) {
	var c Creds
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second) // a locked or stuck keychain must not hold a request for ever
	defer cancel()
	out, err := exec.CommandContext(ctx, "security", "find-generic-password", "-a", account, "-s", keychainService, "-w").Output()
	if err != nil {
		return c, errors.New("gdocsync: no sign-in stored in the keychain for " + account)
	}
	raw, err := hex.DecodeString(strings.TrimSpace(string(out)))
	if err != nil || json.Unmarshal(raw, &c) != nil || c.RefreshToken == "" {
		return Creds{}, errors.New("gdocsync: the stored sign-in is unreadable")
	}
	return c, nil
}

// KeychainTokenFunc returns a TokenFunc that gives a fresh access token from the stored refresh token (cached in memory until a minute before it expires).
func KeychainTokenFunc(account string) func() (string, error) {
	var mu sync.Mutex
	var tok string
	var exp time.Time
	return func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if tok != "" && time.Now().Before(exp.Add(-time.Minute)) {
			return tok, nil
		}
		c, err := LoadCreds(account)
		if err != nil {
			return "", err
		}
		t, ttl, err := exchange(context.Background(), url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.RefreshToken}, "client_id": {c.ClientID}, "client_secret": {c.ClientSecret}})
		if err != nil {
			return "", err
		}
		tok, exp = t.Access, time.Now().Add(ttl)
		return tok, nil
	}
}

// TokenResponse is the parts of Google's answer the sign-in uses.
type TokenResponse struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Expires int    `json:"expires_in"`
	Scope   string `json:"scope"`
}

// Exchange posts a form to the token endpoint (an authorization code at sign-in, the refresh token after).
func Exchange(ctx context.Context, form url.Values) (TokenResponse, error) {
	t, _, err := exchange(ctx, form)
	return t, err
}

func exchange(ctx context.Context, form url.Values) (TokenResponse, time.Duration, error) {
	var t TokenResponse
	req, _ := http.NewRequestWithContext(ctx, "POST", TokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return t, 0, errors.New("gdocsync: the token endpoint could not be reached")
	}
	defer resp.Body.Close()
	var raw map[string]any
	json.NewDecoder(resp.Body).Decode(&raw)
	if resp.StatusCode != 200 {
		e, _ := raw["error"].(string) // the error code only: never echo a body that could hold a credential
		return t, 0, fmt.Errorf("gdocsync: the token endpoint refused (HTTP %d, %q)", resp.StatusCode, e)
	}
	b, _ := json.Marshal(raw)
	json.Unmarshal(b, &t)
	if t.Access == "" {
		return t, 0, errors.New("gdocsync: the token endpoint gave no access token")
	}
	return t, time.Duration(t.Expires) * time.Second, nil
}
