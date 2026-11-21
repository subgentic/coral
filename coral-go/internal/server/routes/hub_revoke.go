package routes

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The Hub's remove-me call (coral-hub #20354, agreed terms): POST <origin>/api/servers/self/unlink, the link's own token as the bearer, the body exactly {server_id, reason}, no query string. The token goes only to the
// stored origin over verified TLS, a redirect is never followed, the call times out at 10 s, the answer is read to 1 KB, and neither the token nor the answer's text is logged or acted on beyond one state word.
const (
	hubUnlinkPath     = "/api/servers/self/unlink"
	hubUnlinkReason   = "removed-here"
	hubRevokeTimeout  = 10 * time.Second
	hubRevokeMaxBody  = 1024
	hubRevokeMaxAfter = 24 * time.Hour
)

// RevokeResult is the Hub's answer and, for a 429, how long it asked this computer to wait.
type RevokeResult struct {
	Answer     RevokeAnswer
	RetryAfter time.Duration
}

type httpRevoker struct {
	enabled func() bool
	client  *http.Client
}

// newHTTPRevoker makes the real caller. enabled is the switch it lands behind (off until a joint real run and the Operator's yes); client nil means the default verified-TLS client with no redirects.
func newHTTPRevoker(enabled func() bool, client *http.Client) *httpRevoker {
	if client == nil {
		client = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, Proxy: http.ProxyFromEnvironment}}
	} else {
		c := *client
		client = &c
	}
	client.Timeout = hubRevokeTimeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &httpRevoker{enabled: enabled, client: client}
}

func (r *httpRevoker) Revoke(ctx context.Context, origin, serverID, token string) RevokeResult {
	if r.enabled == nil || !r.enabled() {
		return RevokeResult{Answer: RevokeUnsupported}
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return RevokeResult{Answer: RevokeRetry} // not a stored origin: nothing is sent
	}
	body, _ := json.Marshal(struct {
		ServerID string `json:"server_id"`
		Reason   string `json:"reason"`
	}{serverID, hubUnlinkReason})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+u.Host+hubUnlinkPath, strings.NewReader(string(body)))
	if err != nil {
		return RevokeResult{Answer: RevokeRetry}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return RevokeResult{Answer: RevokeRetry} // the error text can carry the address: not kept
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		raw, err := io.ReadAll(io.LimitReader(resp.Body, hubRevokeMaxBody+1))
		if err != nil || len(raw) > hubRevokeMaxBody {
			return RevokeResult{Answer: RevokeRetry}
		}
		var ans struct {
			OK    bool   `json:"ok"`
			State string `json:"state"`
		}
		if json.Unmarshal(raw, &ans) != nil || !ans.OK {
			return RevokeResult{Answer: RevokeRetry}
		}
		switch ans.State {
		case "removed":
			return RevokeResult{Answer: RevokeRemoved}
		case "already_gone":
			return RevokeResult{Answer: RevokeAlreadyGone}
		}
		return RevokeResult{Answer: RevokeRetry}
	case http.StatusBadRequest:
		return RevokeResult{Answer: RevokeBadRequest}
	case http.StatusUnauthorized:
		return RevokeResult{Answer: RevokeTokenRefused}
	case http.StatusForbidden:
		return RevokeResult{Answer: RevokeForbidden}
	case http.StatusNotFound:
		return RevokeResult{Answer: RevokeNotFound}
	case http.StatusTooManyRequests:
		res := RevokeResult{Answer: RevokeRetry}
		if secs, err := strconv.ParseInt(strings.TrimSpace(resp.Header.Get("Retry-After")), 10, 64); err == nil && secs > 0 {
			res.RetryAfter = time.Duration(secs) * time.Second
			if secs > int64(hubRevokeMaxAfter/time.Second) || res.RetryAfter > hubRevokeMaxAfter {
				res.RetryAfter = hubRevokeMaxAfter
			}
		}
		return res
	}
	return RevokeResult{Answer: RevokeRetry}
}
