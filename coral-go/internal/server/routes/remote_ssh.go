package routes

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// A server the hub reaches over the owner's SSH session (#11370): the stored ssh_target is "user@host:port" or a Host name of the owner's SSH config (a name has no "@" or ":"). The target is an
// ssh -W stream to the remote's own loopback (sshprov.StreamTarget): no URL, no listening port on this computer.

// sshTargetOf reads a stored ssh_target.
func sshTargetOf(stored string) (sshprov.Target, error) {
	if strings.Contains(stored, "@") {
		return sshprov.ParseTarget(stored)
	}
	return sshprov.FromAlias(stored)
}

// newSSHTarget is the stream target of an ssh server row, with key as its Bearer.
func newSSHTarget(rs *store.RemoteServer, key string) (*sshprov.StreamTarget, error) {
	t, err := sshTargetOf(rs.SSHTarget)
	if err != nil {
		return nil, err
	}
	return sshprov.NewStreamTarget(sshprov.Runner{}, t, rs.RemotePort, key)
}

// sshStreams keeps one stream target per ssh server, so its pooled connections (and the cap and backoff) are shared by the proxy, the poller and the feed instead of starting a new set at each
// resolve. A changed target, port or key replaces the entry.
type sshStreams struct {
	mu sync.Mutex
	m  map[string]sshStream
}

type sshStream struct {
	sig string
	t   *sshprov.StreamTarget
}

func (c *sshStreams) get(rs *store.RemoteServer, key, ownerSecret string) (proxy.Target, error) {
	sum := sha256.Sum256([]byte(rs.SSHTarget + "\x00" + strconv.Itoa(rs.RemotePort) + "\x00" + key + "\x00" + ownerSecret))
	sig := string(sum[:])
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[rs.ID]; ok && e.sig == sig {
		return e.t, nil
	}
	t, err := newSSHTarget(rs, key)
	if err != nil {
		return nil, err
	}
	t.WithOwnerStamp(rs.ID, ownerSecret)
	if c.m == nil {
		c.m = map[string]sshStream{}
	}
	if old, ok := c.m[rs.ID]; ok {
		old.t.Close()
	}
	c.m[rs.ID] = sshStream{sig: sig, t: t}
	return t, nil
}

// forget drops a server's stream target (its idle ssh streams are closed, its key leaves memory): a deleted server, or one whose row changed.
func (c *sshStreams) forget(id string) {
	c.mu.Lock()
	e, ok := c.m[id]
	delete(c.m, id)
	c.mu.Unlock()
	if ok {
		e.t.Close()
	}
}

// CheckTargetHealth is CheckRemoteHealth for a target that is not a URL: GET /api/health through it. A failure to connect is the one fixed sentence, whatever ssh said.
func CheckTargetHealth(ctx context.Context, t proxy.Target, timeout time.Duration) RemoteHealth {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := proxy.Get(ctx, t, "/api/health", "")
	switch {
	case errors.Is(err, proxy.ErrRemoteRejected):
		return RemoteHealth{Status: store.RemoteStatusUnauthorized, Err: "remote rejected API key"}
	case errors.Is(err, proxy.ErrHostRefused):
		return RemoteHealth{Status: store.RemoteStatusHostRefused, Err: proxy.ErrHostRefused.Error()}
	case err != nil:
		return RemoteHealth{Status: store.RemoteStatusUnreachable, Err: "could not connect"}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return RemoteHealth{Status: store.RemoteStatusUnreachable, Err: "remote did not answer"}
	}
	var body struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&body); err != nil || body.Status != "ok" {
		return RemoteHealth{Status: store.RemoteStatusUnreachable, Err: "remote is not a Coral server"}
	}
	return RemoteHealth{Status: store.RemoteStatusOnline, Version: body.Version}
}

// updateSSH is PATCH /api/servers/{id} for a server reached over SSH: its label and its key can be edited. It has no URL and no private-network switch, and a request that names either is refused,
// so an ssh server can never be turned into a direct one.
func (h *RemoteServersHandler) updateSSH(w http.ResponseWriter, r *http.Request, cur *store.RemoteServer, req remoteServerRequest) {
	if req.URL != nil || req.AllowPrivate != nil {
		errBadRequest(w, "this server is reached over SSH: it has no URL or private-network setting")
		return
	}
	upd := store.RemoteServerUpdate{}
	if req.Label != nil {
		l := strings.TrimSpace(*req.Label)
		if l == "" {
			errBadRequest(w, "label must not be empty")
			return
		}
		upd.Label = &l
	}
	if req.APIKey != nil {
		if strings.TrimSpace(*req.APIKey) == "" {
			errBadRequest(w, "api_key must not be empty")
			return
		}
		t, err := newSSHTarget(cur, *req.APIKey)
		if err != nil {
			errBadRequest(w, "this server's SSH target is not valid")
			return
		}
		health := CheckTargetHealth(r.Context(), t, h.healthTimeout)
		t.Close()
		if health.Status != store.RemoteStatusOnline {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": health.Err, "status": health.Status})
			return
		}
		upd.APIKey = req.APIKey
	}
	srv, err := h.store.Update(r.Context(), cur.ID, upd)
	if err != nil {
		remoteErr(w, err)
		return
	}
	if req.APIKey != nil {
		h.store.SetStatus(r.Context(), cur.ID, store.RemoteStatusOnline, "")
		h.tellStatus(cur.ID, store.RemoteStatusOnline)
		srv, _ = h.store.Get(r.Context(), cur.ID)
	}
	writeJSON(w, http.StatusOK, viewRemote(srv))
}

// testSSH is the health probe of an ssh server (POST /api/servers/{id}/test).
func (h *RemoteServersHandler) testSSH(ctx context.Context, cur *store.RemoteServer, key string) RemoteHealth {
	t, err := newSSHTarget(cur, key)
	if err != nil {
		return RemoteHealth{Status: store.RemoteStatusUnreachable, Err: "this server's SSH target is not valid"}
	}
	defer t.Close()
	return CheckTargetHealth(ctx, t, h.healthTimeout)
}
