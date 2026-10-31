// How the hub keeps one remote server's state: the poll loop, the health and version probes, the list fetch, and the online and failure records with their offline grace. Moved out of remote_agents.go (#8259), no code changed.

package background

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/store"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

func (h *RemoteAgentHub) jitter(d time.Duration) time.Duration {
	return d - d/5 + time.Duration(rand.Int63n(int64(d)/5*2+1))
}

func SleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// pollLoop polls one remote until ctx ends.
func (h *RemoteAgentHub) pollLoop(ctx context.Context, id string) {
	h.mu.Lock()
	st, ok := h.current(id)
	h.mu.Unlock()
	if !ok {
		return
	}
	wake := st.wake
	backoff := h.cfg.MinBackoff
	for {
		probed := h.now()
		var sessions []map[string]any
		var err error
		feedFresh := h.feedCarriesList(id)
		if feedFresh {
			// The feed supplies the list; only check that the remote answers.
			if err = h.checkHealth(ctx, id); errors.Is(err, errNoHealthEndpoint) {
				// An older remote: fall back to the list for good, never
				// mark a working remote unreachable.
				h.mu.Lock()
				if st, ok := h.current(id); ok {
					st.noHealth = true
				}
				h.mu.Unlock()
				feedFresh = false
			}
		}
		if !feedFresh {
			sessions, err = h.fetchLive(ctx, id)
		}
		if ctx.Err() != nil {
			return
		}
		var wait time.Duration
		if err == nil {
			if feedFresh {
				h.recordAlive(ctx, id)
			} else {
				h.recordOnline(ctx, id, sessions)
				h.refreshVersion(ctx, id)
			}
			backoff = h.cfg.MinBackoff
			wait = h.jitter(h.cfg.PollInterval)
		} else {
			h.recordFailure(ctx, id, err)
			wait = backoff
			if backoff *= 2; backoff > h.cfg.MaxBackoff {
				backoff = h.cfg.MaxBackoff
			}
		}
		if !h.waitOrWake(ctx, wake, wait, probed) {
			return
		}
	}
}

// waitOrWake waits for d, or less if the loop is kicked (a proxied request to
// the remote failed), so the next probe settles the status at once (#3202).
// Probes stay at least MinBackoff apart, so a burst of failures cannot turn
// into a burst of probes. It returns false when ctx ends.
func (h *RemoteAgentHub) waitOrWake(ctx context.Context, wake <-chan struct{}, d time.Duration, probed time.Time) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	case <-wake:
		return h.sleep(ctx, h.cfg.MinBackoff-h.now().Sub(probed))
	}
}

// feedCarriesList reports whether the remote's feed is connected and has
// delivered a message within FeedQuietRefresh, so polling the list would only
// fetch data the feed already supersedes.
func (h *RemoteAgentHub) feedCarriesList(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	st, ok := h.current(id)
	return ok && st.feedLive && !st.noHealth && time.Since(st.feedMsgAt) < h.cfg.FeedQuietRefresh
}

// errNoHealthEndpoint means the remote answered /api/health with 404: it
// predates the endpoint, which says nothing about whether it is up.
var errNoHealthEndpoint = errors.New("remote has no /api/health endpoint")

// checkHealth GETs /api/health and records the reported version. It is the
// liveness check used while the feed carries the list.
func (h *RemoteAgentHub) checkHealth(ctx context.Context, id string) error {
	t, err := h.resolver.Resolve(ctx, id)
	if err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	resp, err := proxy.Get(rctx, t, "/api/health", "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return errNoHealthEndpoint
	}
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return errors.New("remote returned HTTP " + resp.Status)
	}
	var body struct {
		Version       string `json:"version"`
		HubOwnerStamp bool   `json:"hub_owner_stamp"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body); err != nil {
		return errors.New("remote returned an invalid health response")
	}
	h.mu.Lock()
	changed := false
	if st, ok := h.current(id); ok {
		if body.Version != "" && st.version != body.Version {
			st.version, st.versionAt, changed = body.Version, time.Now(), true
		}
		if st.ownerStamp != body.HubOwnerStamp { // the remote says whether it holds the secret that verifies this hub's owner stamps (#11378)
			st.ownerStamp, changed = body.HubOwnerStamp, true
		}
	}
	h.mu.Unlock()
	if changed {
		h.notify()
	}
	return nil
}

// recordAlive is recordOnline for a liveness check that carries no list: the
// status and the periodic last_seen write, sessions untouched.
func (h *RemoteAgentHub) recordAlive(ctx context.Context, id string) {
	h.mu.Lock()
	st, ok := h.current(id)
	if !ok {
		h.mu.Unlock()
		return
	}
	changed := st.status != store.RemoteStatusOnline
	if changed {
		h.logTransition(id, st.status, store.RemoteStatusOnline, "")
	}
	st.status = store.RemoteStatusOnline
	st.failingSince = time.Time{}
	writeDB := st.rowNeedsWrite(changed, store.RemoteStatusOnline)
	if writeDB {
		st.lastDB, st.srv.Status = time.Now(), store.RemoteStatusOnline
	}
	h.mu.Unlock()
	if writeDB {
		_ = h.reg.SetStatus(ctx, id, store.RemoteStatusOnline, "")
	}
	if changed {
		h.notify()
	}
}

// refreshVersion reads the remote's version from /api/health at most once a
// minute. It is for display only, so failures are ignored.
func (h *RemoteAgentHub) refreshVersion(ctx context.Context, id string) {
	h.mu.Lock()
	st, ok := h.current(id)
	due := ok && time.Since(st.versionAt) > time.Minute
	if due {
		st.versionAt = time.Now()
	}
	h.mu.Unlock()
	if !due {
		return
	}
	t, err := h.resolver.Resolve(ctx, id)
	if err != nil {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	resp, err := proxy.Get(rctx, t, "/api/health", "")
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var body struct {
		Version       string `json:"version"`
		HubOwnerStamp bool   `json:"hub_owner_stamp"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body) != nil || body.Version == "" {
		return
	}
	h.mu.Lock()
	changed := false
	if st, ok := h.current(id); ok {
		if st.version != body.Version {
			st.version, changed = body.Version, true
		}
		if st.ownerStamp != body.HubOwnerStamp {
			st.ownerStamp, changed = body.HubOwnerStamp, true
		}
	}
	h.mu.Unlock()
	if changed {
		h.notify()
	}
}

func (h *RemoteAgentHub) fetchLive(ctx context.Context, id string) ([]map[string]any, error) {
	t, err := h.resolver.Resolve(ctx, id)
	if err != nil {
		return nil, err
	}
	rctx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	resp, err := proxy.Get(rctx, t, "/api/sessions/live", "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, errors.New("remote returned HTTP " + resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	return parseLiveList(body)
}

func (h *RemoteAgentHub) recordOnline(ctx context.Context, id string, sessions []map[string]any) {
	h.mu.Lock()
	st, ok := h.current(id)
	if !ok {
		h.mu.Unlock()
		return
	}
	changed := st.status != store.RemoteStatusOnline
	statusChanged := changed
	if changed {
		h.logTransition(id, st.status, store.RemoteStatusOnline, "")
	}
	st.status = store.RemoteStatusOnline
	st.failingSince = time.Time{}
	if !st.feedLive {
		if sig := sessionsSig(sessions); sig != st.lastSig || changed {
			changed = changed || sig != st.lastSig
			st.lastSig = sig
			st.sessions = sessions
		}
	}
	// The row records status and last_seen, not sessions: a session change
	// does not need a write (#3142).
	writeDB := st.rowNeedsWrite(statusChanged, store.RemoteStatusOnline)
	if writeDB {
		st.lastDB, st.srv.Status = time.Now(), store.RemoteStatusOnline
	}
	h.mu.Unlock()
	if writeDB {
		_ = h.reg.SetStatus(ctx, id, store.RemoteStatusOnline, "")
	}
	if changed {
		h.notify()
	}
}

func (h *RemoteAgentHub) recordFailure(ctx context.Context, id string, err error) {
	status := store.RemoteStatusUnreachable
	switch {
	case errors.Is(err, proxy.ErrRemoteRejected):
		status = store.RemoteStatusUnauthorized
	case errors.Is(err, proxy.ErrKeyUnreadable):
		status = store.RemoteStatusKeyUnreadable
	case errors.Is(err, proxy.ErrHostRefused):
		status = store.RemoteStatusHostRefused
	}
	h.mu.Lock()
	st, ok := h.current(id)
	if !ok {
		h.mu.Unlock()
		return
	}
	if h.withinOfflineGrace(st, status) {
		h.mu.Unlock()
		h.logger.Debug("remote probe failed; still within the offline grace", "server", id, "error", err)
		return
	}
	msg := err.Error()
	if status == store.RemoteStatusUnauthorized {
		msg = "remote rejected API key"
	}
	changed := st.status != status
	if changed {
		h.logTransition(id, st.status, status, msg)
	}
	st.status = status
	st.feedLive = false
	// A repeated failure with the same error is written at most once a minute;
	// a new status or a different error is written at once (#3142).
	writeDB := st.rowNeedsWrite(changed, status) || msg != st.lastErr
	if writeDB {
		st.lastDB, st.srv.Status = time.Now(), status
		st.lastErr = msg
	}
	h.mu.Unlock()
	if writeDB {
		_ = h.reg.SetStatus(ctx, id, status, msg)
	}
	if changed {
		h.notify()
	}
}

// Refresh takes a server's status from an edit or a Test that just checked it (#3649): the
// worker's own view, which is what the dashboard shows, becomes that status at once instead of
// after its next probe (up to MaxBackoff away after a run of failures), and the worker probes
// again now.
func (h *RemoteAgentHub) Refresh(id, status string) {
	h.mu.Lock()
	st, ok := h.current(id)
	if ok {
		if st.status != status {
			h.logTransition(id, st.status, status, "the server was edited or tested")
		}
		st.status, st.srv.Status = status, status
		if status == store.RemoteStatusOnline {
			st.lastErr = ""
		}
		h.snap = nil
		st.kick()
	}
	h.mu.Unlock()
	if ok {
		h.notify()
	}
}

// withinOfflineGrace reports whether an unreachable result is kept from a server
// shown online because its failures haven't lasted OfflineGrace yet (#3649). It
// starts the run on the first failure. Any other status (a rejected key, a
// refused host, an unreadable key) is never held back. Called with h.mu held.
func (h *RemoteAgentHub) withinOfflineGrace(st *remoteState, status string) bool {
	if h.cfg.OfflineGrace < 0 || status != store.RemoteStatusUnreachable || st.status != store.RemoteStatusOnline {
		return false
	}
	now := time.Now()
	if st.failingSince.IsZero() {
		st.failingSince = now
	}
	return now.Sub(st.failingSince) < h.cfg.OfflineGrace
}

// ReportFailure records a failure seen outside the worker, i.e. a proxied
// dashboard request to the remote (#3202). The worker's own status changes with
// the registry row, so the two never disagree, and the worker probes again at
// once: a remote that is fine is back to online within a probe, instead of the
// row staying failed until the next periodic write or a Test. A key_unreadable
// report does not stop the worker; its own probe decides. It returns false if
// no worker runs for id, and the caller records the status itself.
func (h *RemoteAgentHub) ReportFailure(ctx context.Context, id, status, msg string) bool {
	h.mu.Lock()
	st, ok := h.current(id)
	if !ok || st.cancel == nil {
		h.mu.Unlock()
		return false
	}
	if h.withinOfflineGrace(st, status) {
		st.kick() // the worker's probe decides once the grace is over
		h.mu.Unlock()
		return true
	}
	changed := st.status != status
	if changed {
		h.logTransition(id, st.status, status, msg+" (proxied request)")
	}
	st.status = status
	st.lastDB, st.lastErr, st.srv.Status = time.Now(), msg, status
	st.kick()
	h.mu.Unlock()
	_ = h.reg.SetStatus(ctx, id, status, msg)
	// A probe may have finished between the unlock and the write: it wrote its own
	// status (say online) and recorded that the row says so, and this write then put
	// the failure back in the row. Record what the row really says now, so the next
	// probe sees the mismatch and corrects the row at once.
	h.mu.Lock()
	if st, ok := h.current(id); ok && st.status != status {
		st.srv.Status = status
		st.kick()
	}
	h.mu.Unlock()
	if changed {
		h.notify()
	}
	return true
}

// logTransition logs one line per status change. msg is an error message the
// registry also stores, never key material.
func (h *RemoteAgentHub) logTransition(id, from, to, msg string) {
	if from == "" {
		from = store.RemoteStatusUnknown
	}
	if msg == "" {
		h.logger.Info("remote status changed", "server", id, "from", from, "to", to)
		return
	}
	h.logger.Info("remote status changed", "server", id, "from", from, "to", to, "error", msg)
}
