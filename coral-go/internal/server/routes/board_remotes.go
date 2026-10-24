package routes

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/store"
)

// BoardRemotesHandler handles remote board subscription and proxy endpoints.
type BoardRemotesHandler struct {
	rbs *store.RemoteBoardStore
	cfg *config.Config
	// resolve is the SSRF check of a remote's URL (the address the request is pinned to); nil: httputil.ResolveAndValidateURL. A test whose remote is on loopback sets its own.
	resolve func(rawURL string) (string, error)
}

// NewBoardRemotesHandler creates a new BoardRemotesHandler.
func NewBoardRemotesHandler(db *store.DB, cfg *config.Config) *BoardRemotesHandler {
	return &BoardRemotesHandler{
		rbs: store.NewRemoteBoardStore(db),
		cfg: cfg,
	}
}

// --- Subscription CRUD ---

type remoteSubRequest struct {
	SessionID    string `json:"session_id"`
	RemoteServer string `json:"remote_server"`
	Project      string `json:"project"`
	JobTitle     string `json:"job_title"`
}

type remoteSubDeleteRequest struct {
	SessionID string `json:"session_id"`
}

// AddSubscription handles POST /api/board/remotes
func (h *BoardRemotesHandler) AddSubscription(w http.ResponseWriter, r *http.Request) {
	var req remoteSubRequest
	if err := decodeJSON(r, &req); err != nil {
		errBadRequest(w, "invalid request body")
		return
	}

	// SSRF validation: ensure the remote server URL doesn't resolve to private/reserved IPs
	if _, err := httputil.ResolveAndValidateURL(req.RemoteServer); err != nil {
		errBadRequest(w, err.Error())
		return
	}

	sub, err := h.rbs.AddRemoteSub(r.Context(), req.SessionID, req.RemoteServer, req.Project, req.JobTitle)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

// RemoveSubscription handles DELETE /api/board/remotes
func (h *BoardRemotesHandler) RemoveSubscription(w http.ResponseWriter, r *http.Request) {
	var req remoteSubDeleteRequest
	if err := decodeJSON(r, &req); err != nil {
		errBadRequest(w, "invalid request body")
		return
	}

	removed, err := h.rbs.RemoveRemoteSubs(r.Context(), req.SessionID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}

// ListSubscriptions handles GET /api/board/remotes
func (h *BoardRemotesHandler) ListSubscriptions(w http.ResponseWriter, r *http.Request) {
	subs, err := h.rbs.ListAllRemoteSubs(r.Context())
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, subs)
}

// --- Proxy Endpoints ---

// ProxyProjects handles GET /api/board/remotes/proxy/{remote_server}/projects
func (h *BoardRemotesHandler) ProxyProjects(w http.ResponseWriter, r *http.Request) {
	// URL pattern: /api/board/remotes/proxy/{remoteServer}/projects. The route's own parameter, percent-decoded: the registered server's URL has slashes, so a client sends it escaped; it only selects
	// which registered subscription is meant (proxyGet uses the registered string, never this one).
	server := urlParam(r, "remoteServer")
	if server == "" {
		errBadRequest(w, "missing remote server")
		return
	}
	result, code, err := h.proxyGet(r.Context(), server, "/projects")
	if err != nil {
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(result)
}

// ProxyMessages handles GET /api/board/remotes/proxy/{remote_server}/{project}/messages/all
func (h *BoardRemotesHandler) ProxyMessages(w http.ResponseWriter, r *http.Request) {
	remoteServer := urlParam(r, "remoteServer") // decoded, to find the registered server; it is never the URL used (#7290)
	project := urlParam(r, "project")
	// A number from 1 to 500, formatted here: the caller's text never reaches the remote's query string (#4602).
	limit := clampLimit(queryInt(r, "limit", 200), 200, 500)
	if !remoteProjectOK(w, project) {
		return
	}
	path := fmt.Sprintf("/%s/messages/all?limit=%d", url.PathEscape(project), limit)
	result, code, err := h.proxyGet(r.Context(), remoteServer, path)
	if err != nil {
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(result)
}

// ProxySubscribers handles GET /api/board/remotes/proxy/{remote_server}/{project}/subscribers
func (h *BoardRemotesHandler) ProxySubscribers(w http.ResponseWriter, r *http.Request) {
	remoteServer := urlParam(r, "remoteServer") // decoded, to find the registered server; it is never the URL used (#7290)
	project := urlParam(r, "project")
	if !remoteProjectOK(w, project) {
		return
	}
	path := fmt.Sprintf("/%s/subscribers", url.PathEscape(project))
	result, code, err := h.proxyGet(r.Context(), remoteServer, path)
	if err != nil {
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(result)
}

// ProxyCheckUnread handles GET /api/board/remotes/proxy/{remote_server}/{project}/messages/check
func (h *BoardRemotesHandler) ProxyCheckUnread(w http.ResponseWriter, r *http.Request) {
	remoteServer := urlParam(r, "remoteServer") // decoded, to find the registered server; it is never the URL used (#7290)
	project := urlParam(r, "project")
	// subscriber_id, escaped: it was sent on as typed (#3743), so an '&' in it added parameters.
	if !remoteProjectOK(w, project) {
		return
	}
	path := fmt.Sprintf("/%s/messages/check?subscriber_id=%s", url.PathEscape(project), url.QueryEscape(r.URL.Query().Get("subscriber_id")))
	result, code, err := h.proxyGet(r.Context(), remoteServer, path)
	if err != nil {
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(result)
}

// remoteProjectOK refuses a project that is not one path segment of the remote's /api/board/: the name urlParam hands over is percent-DECODED, so "..%2F..%2Fsessions%3Fx=" would walk the pinned URL off /api/board/
// and rewrite its query (CodeQL #490, #7290). Empty, ".", "..", a name with a slash, a backslash, "?", "#" or a control character is a 400; what passes is also url.PathEscape'd where it is used.
func remoteProjectOK(w http.ResponseWriter, project string) bool {
	bad := project == "" || project == "." || project == ".." || len(project) > 200
	for _, c := range project {
		if c == '/' || c == '\\' || c == '?' || c == '#' || c < 0x20 || c == 0x7f {
			bad = true
		}
	}
	if bad {
		errBadRequest(w, "project must be a board name: one path segment with no '/', '\\', '?', '#' or control character")
		return false
	}
	return true
}

// pinnedRemoteURL is the URL the proxy asks: the registered scheme, the resolved address and port (an IPv6 address is bracketed by net.JoinHostPort) and /api/board plus the path built here.
func pinnedRemoteURL(scheme, ip, port, path string) string {
	return scheme + "://" + net.JoinHostPort(ip, port) + "/api/board" + path
}

// hostHeader is a registered hostname as a Host header: an IPv6 literal is bracketed.
func hostHeader(host string) string {
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

// proxyGet forwards a GET request to a remote Coral server's board API with SSRF protection.
func (h *BoardRemotesHandler) proxyGet(ctx context.Context, remoteServer, path string) ([]byte, int, error) {
	// Validate remote server is a registered subscription
	subs, err := h.rbs.ListAllRemoteSubs(ctx)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("failed to list subscriptions: %w", err)
	}

	// From here on the registered subscription's own server string is the remote: parsed, resolved and used as the Host, never the caller's spelling of it (#7290).
	registeredServer := ""
	for _, sub := range subs {
		if strings.TrimRight(sub.RemoteServer, "/") == strings.TrimRight(remoteServer, "/") {
			registeredServer = sub.RemoteServer
			break
		}
	}
	if registeredServer == "" {
		return nil, http.StatusForbidden, fmt.Errorf("remote server is not registered. Add a subscription first")
	}
	remoteServer = registeredServer

	// Resolve and validate IP to prevent SSRF + DNS rebinding
	resolveURL := h.resolve
	if resolveURL == nil {
		resolveURL = httputil.ResolveAndValidateURL
	}
	resolvedIP, err := resolveURL(remoteServer)
	if err != nil {
		return nil, http.StatusForbidden, err
	}

	// Build pinned URL using resolved IP
	parsed, err := url.Parse(strings.TrimRight(remoteServer, "/"))
	if err != nil {
		return nil, http.StatusBadRequest, fmt.Errorf("invalid remote server URL")
	}

	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}

	pinnedURL := pinnedRemoteURL(parsed.Scheme, resolvedIP, port, path)

	// A redirect is not followed (as remote_servers.go): the check above is of the registered address only, and a Location could send this request to any host and bring its body back (CodeQL #490, #7046).
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, "GET", pinnedURL, nil)
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("failed to create request: %w", err)
	}
	// Set Host header to original hostname for correct routing
	req.Host = hostHeader(parsed.Hostname())

	resp, err := client.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("cannot reach remote server %s: %w", remoteServer, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024)) // 10MB limit
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("failed to read remote response: %w", err)
	}

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return nil, http.StatusBadGateway, fmt.Errorf("remote server redirected the request, which is not followed")
	}
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, fmt.Errorf("remote server error: %s", string(body))
	}

	return body, http.StatusOK, nil
}

// SSRF validation uses httputil.ResolveAndValidateURL and httputil.IsIPBlocked.
