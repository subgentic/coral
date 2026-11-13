package routes

// Dropbox connected once on the Hub, Coral's half (#16109, contract r2/r3, Security's four conditions on #210686). The Hub calls three routes on this computer, over the tunnel, as the owner:
// prepare (check, scan and hash a file), push (stream it once to the one-time link the Hub holds) and shared (a yes/no hint for Coral's own UI). Coral never calls the Hub for Dropbox, never sees
// the Dropbox token, and receives the link only in push, in memory for that one request. Everything is dark behind the owner's local switch "Share through Coral Hub" (off by default, set only on this
// computer). "Upload anyway" for a held file is a separate local-only route: a click in this computer's own dashboard, valid ten minutes, used once by push.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/hubdropbox"
	"github.com/subgentic/coral/internal/secfile"
)

const (
	hubDropboxAnywayTTL = 10 * time.Minute
	hubDropboxFieldMax  = 80
	hubDropboxLinkMax   = 1024
	hubDropboxPushMax   = 120 * time.Second
	// hubDropboxSharedMax caps the in-memory yes/no hint: the Hub could otherwise grow it one digest at a time (#16206, Security on #16109).
	hubDropboxSharedMax = 4096
)

// HubDropbox is the state and the checks behind the three routes. Every dependency is a function so a test can fake it, and an unset one fails closed.
type HubDropbox struct {
	CoralDir string
	// On reports the owner's local switch. Unset or an error means off.
	On func(ctx context.Context) (bool, error)
	// Private and Internal read the artifact's private mark and its tag "internal" (on any board) fresh each call; an error means do not send.
	Private  func(ctx context.Context, digest string) (bool, error)
	Internal func(ctx context.Context, digest string) (bool, error)
	// Who names the file's board and uploader, from Coral's own upload record, for the Hub's folder (the Hub cleans them again).
	Who func(digest string) (name, project, agent string)
	// Client is the upload client; a test supplies one with a fake transport.
	Client func(allowed func(context.Context) (bool, error)) *hubdropbox.Uploader
	Now    func() time.Time
	// Enrolment is this computer's Hub address and server id, from its enrolment record only (never from a request, an artifact or a page): the Share button
	// opens the Hub's page at that address. Unset: the Hub is not offered.
	Enrolment func(ctx context.Context) (hubURL, serverID string, err error)

	busy   sync.Mutex // one prepare or push at a time per computer
	mu     sync.Mutex
	anyway map[string]time.Time
	shared map[string]bool
}

func (d *HubDropbox) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *HubDropbox) enabled(ctx context.Context) bool {
	if d.On == nil {
		return false
	}
	on, err := d.On(ctx)
	return err == nil && on
}

// allowedToSend is the gate asked right before the bytes go: not private, not tagged internal, and both reads worked.
func (d *HubDropbox) allowedToSend(digest string) func(context.Context) (bool, error) {
	return func(ctx context.Context) (bool, error) {
		if d.Private == nil || d.Internal == nil {
			return false, errors.New("no mark reader")
		}
		priv, err := d.Private(ctx, digest)
		if err != nil || priv {
			return false, err
		}
		internal, err := d.Internal(ctx, digest)
		if err != nil || internal {
			return false, err
		}
		return true, nil
	}
}

// AllowAnyway records the owner's click for a digest (ten minutes, once).
func (d *HubDropbox) AllowAnyway(digest string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.anyway == nil {
		d.anyway = map[string]time.Time{}
	}
	now := d.now()
	for k, t := range d.anyway {
		if now.Sub(t) > hubDropboxAnywayTTL {
			delete(d.anyway, k)
		}
	}
	d.anyway[digest] = now
}

func (d *HubDropbox) hasAnyway(digest string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.anyway[digest]
	return ok && d.now().Sub(t) <= hubDropboxAnywayTTL
}

// takeAnyway uses the click up.
func (d *HubDropbox) takeAnyway(digest string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.anyway[digest]
	delete(d.anyway, digest)
	return ok && d.now().Sub(t) <= hubDropboxAnywayTTL
}

// Shared is the hint the Hub sends after Share and Stop sharing: yes or no per digest, kept in memory for Coral's own page. The Hub's page is the truth.
func (d *HubDropbox) Shared(digest string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.shared[digest]
}

// setShared records a yes or forgets it, and reports whether the hint was kept: a yes is kept only for a digest of a real artifact on this computer and only while fewer than hubDropboxSharedMax are held (#16206).
func (d *HubDropbox) setShared(digest string, yes bool) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !yes {
		delete(d.shared, digest)
		return true
	}
	if !d.isArtifact(digest) {
		return false
	}
	if d.shared == nil {
		d.shared = map[string]bool{}
	}
	if _, held := d.shared[digest]; !held && len(d.shared) >= hubDropboxSharedMax {
		return false
	}
	d.shared[digest] = true
	return true
}

// isArtifact is whether the artifact store holds a regular file under this digest (a link or a folder is not one). It reads no bytes.
func (d *HubDropbox) isArtifact(digest string) bool {
	st, err := os.Lstat(filepath.Join(d.CoralDir, "artifacts", "objects", digest))
	return err == nil && st.Mode().IsRegular()
}

// strictBody reads a closed JSON object: the body is at most max bytes, every key is exactly one of keys, none is repeated or missing, and nothing follows it.
func strictBody(r *http.Request, max int64, keys ...string) (map[string]json.RawMessage, bool) {
	if r.URL.RawQuery != "" {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil || int64(len(raw)) > max {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, false
	}
	out := map[string]json.RawMessage{}
	for dec.More() {
		kt, err := dec.Token()
		k, ok := kt.(string)
		if err != nil || !ok {
			return nil, false
		}
		if _, dup := out[k]; dup {
			return nil, false
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, false
		}
		out[k] = v
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	if len(out) != len(keys) {
		return nil, false
	}
	for _, k := range keys {
		if _, ok := out[k]; !ok {
			return nil, false
		}
	}
	return out, true
}

func strField(m map[string]json.RawMessage, k string) (string, bool) {
	var s string
	if json.Unmarshal(m[k], &s) != nil {
		return "", false
	}
	return s, true
}

func lowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// cleanHubField is a name, project or agent as Coral sends it: 1 to 80 bytes of valid text with no separator, no control character and no leading dot. Anything else is refused, not repaired.
func cleanHubField(s string) bool {
	if s == "" || len(s) > hubDropboxFieldMax || !utf8.ValidString(s) || strings.HasPrefix(s, ".") {
		return false
	}
	for _, r := range s {
		if r == '/' || r == '\\' || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// readFile reads the artifact object once, never through a link.
func (d *HubDropbox) readFile(digest string) (*hubdropbox.File, error) {
	f, err := secfile.OpenNoFollow(filepath.Join(d.CoralDir, "artifacts", "objects", digest), os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	return hubdropbox.ReadOnce(f)
}

type hubDropboxWord map[string]any

func word(w string) hubDropboxWord { return hubDropboxWord{"word": w} }

func (d *HubDropbox) reply(w http.ResponseWriter, v any) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, v)
}

func badHubDropbox(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusBadRequest, map[string]any{})
}

// Prepare answers POST /api/dropbox/prepare {"digest"}: is this file one Coral may send, and what are its size and names. Nothing leaves this computer.
func (d *HubDropbox) Prepare(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // the table marks this route owner-only from the Hub (OwnerHubOnly): anyone else, and a request from this computer, gets 403 owner_only before anything is read
		return
	}
	m, ok := strictBody(r, 256, "digest")
	digest, okd := strField(m, "digest")
	if !ok || !okd || !lowerHex64(digest) {
		badHubDropbox(w)
		return
	}
	ctx := r.Context()
	if !d.enabled(ctx) {
		d.reply(w, word("disabled"))
		return
	}
	if !d.busy.TryLock() {
		d.reply(w, word("busy"))
		return
	}
	defer d.busy.Unlock()
	if ok, err := d.allowedToSend(digest)(ctx); err != nil || !ok {
		d.reply(w, word("not_available"))
		return
	}
	f, err := d.readFile(digest)
	if err != nil || f.Digest != digest || f.Size < 1 {
		d.reply(w, word("not_available"))
		return
	}
	if f.Flagged && !d.hasAnyway(digest) {
		d.reply(w, word("held"))
		return
	}
	name, project, agent := "", "", ""
	if d.Who != nil {
		name, project, agent = d.Who(digest)
	}
	if !cleanHubField(name) || !cleanHubField(project) || !cleanHubField(agent) {
		d.reply(w, word("not_available"))
		return
	}
	slog.Info("[hub-dropbox] prepare", "digest", digest[:8], "word", "ok")
	d.reply(w, hubDropboxWord{"word": "ok", "size": f.Size, "name": name, "project": project, "agent": agent})
}

// validPushLink is the Hub's link checked: hubdropbox's rules (https, host exactly content.dropboxapi.com, port 443 or none, no user info) and a path under /2/files/.
func validPushLink(raw string) bool {
	if len(raw) < 1 || len(raw) > hubDropboxLinkMax {
		return false
	}
	u, err := hubdropbox.ValidLink(raw)
	if err != nil {
		return false
	}
	// u.Path is the decoded path, so %2e%2e and %2E%2E are ".." here: a path that cleans to something else (dot segments, a doubled or trailing slash) is refused (#16206, Security INFO on #16109).
	return strings.HasPrefix(u.Path, "/2/files/") && !strings.Contains(u.EscapedPath(), "..") && path.Clean(u.Path) == u.Path
}

// Push answers POST /api/dropbox/push {"digest","link"}: read the file once and send it to the link. Order, each step failing closed: the link, the switch, the mark and tag, one read whose SHA-256 must be the digest,
// a flagged file needing an unused "Upload anyway" (used up here), then one request. Nothing is sent before every check has passed on the whole file.
func (d *HubDropbox) Push(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // the table marks this route owner-only from the Hub (OwnerHubOnly): anyone else, and a request from this computer, gets 403 owner_only before anything is read
		return
	}
	m, ok := strictBody(r, 2<<10, "digest", "link")
	digest, okd := strField(m, "digest")
	link, okl := strField(m, "link")
	if !ok || !okd || !okl || !lowerHex64(digest) || link == "" {
		badHubDropbox(w)
		return
	}
	ctx := r.Context()
	if !d.enabled(ctx) {
		d.reply(w, word("disabled"))
		return
	}
	if !validPushLink(link) {
		d.reply(w, word("not_available"))
		return
	}
	if !d.busy.TryLock() {
		d.reply(w, word("busy"))
		return
	}
	defer d.busy.Unlock()
	gate := d.allowedToSend(digest)
	if ok, err := gate(ctx); err != nil || !ok {
		d.reply(w, word("not_available"))
		return
	}
	f, err := d.readFile(digest)
	if err != nil {
		d.reply(w, word("not_available"))
		return
	}
	if f.Digest != digest {
		d.reply(w, word("failed"))
		return
	}
	if f.Flagged && !d.takeAnyway(digest) {
		d.reply(w, word("held"))
		return
	}
	limit := 30*time.Second + time.Duration(f.Size>>20)*time.Second
	if limit > hubDropboxPushMax {
		limit = hubDropboxPushMax
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	up := hubdropbox.NewUploader(gate)
	if d.Client != nil {
		up = d.Client(gate)
	}
	err = up.Upload(ctx, link, digest, f)
	out := word("failed")
	var ref *hubdropbox.Refused
	var rl *hubdropbox.RateLimited
	switch {
	case err == nil:
		out = hubDropboxWord{"word": "ok", "content_hash": f.ContentHash, "size": f.Size}
	case errors.Is(err, hubdropbox.ErrNotAllowed), errors.Is(err, hubdropbox.ErrBadLink):
		out = word("not_available")
	case errors.As(err, &rl):
		out = word("rate_limited")
	case errors.As(err, &ref) && ref.Status == http.StatusConflict && ref.QuotaFull:
		out = word("quota_full")
	case errors.As(err, &ref) && ref.Status == http.StatusGone:
		out = word("expired")
	}
	slog.Info("[hub-dropbox] push", "digest", digest[:8], "word", out["word"])
	d.reply(w, out)
}

// SharedHint answers POST /api/dropbox/shared {"digest","shared"}: a yes or no for Coral's own page. Off, it answers ok and records nothing.
func (d *HubDropbox) SharedHint(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // the table marks this route owner-only from the Hub (OwnerHubOnly): anyone else, and a request from this computer, gets 403 owner_only before anything is read
		return
	}
	m, ok := strictBody(r, 256, "digest", "shared")
	digest, okd := strField(m, "digest")
	var shared bool
	if ok {
		ok = json.Unmarshal(m["shared"], &shared) == nil
	}
	if !ok || !okd || !lowerHex64(digest) {
		badHubDropbox(w)
		return
	}
	if d.enabled(r.Context()) && !d.setShared(digest, shared) {
		d.reply(w, word("not_available")) // not an artifact here, or the hint is full: nothing was kept
		return
	}
	d.reply(w, word("ok"))
}

// UploadAnyway answers POST /api/dropbox/upload-anyway/{digest}: the owner, at this computer's own dashboard, lets one held file go. Not in the tunnel's route table; the caller checks it is a person here.
func (d *HubDropbox) UploadAnyway(w http.ResponseWriter, r *http.Request) {
	digest := chi.URLParam(r, "digest")
	if !lowerHex64(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	if !d.enabled(r.Context()) {
		writeError(w, http.StatusConflict, "disabled", "Sharing through Coral Hub is off on this computer")
		return
	}
	d.AllowAnyway(digest)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "valid_minutes": int(hubDropboxAnywayTTL / time.Minute)})
}

var hubServerIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// hubSharePage is the Hub's own Share page for one file, built from the enrolment record only: https (http only for a loopback Hub, as a development Hub is),
// no user info, the Hub's origin and a fixed path. Anything else is "" (nothing is offered).
func hubSharePage(hubURL, serverID, digest string) string {
	u, err := url.Parse(hubURL)
	if err != nil || u.Host == "" || u.User != nil || !hubServerIDRe.MatchString(serverID) || !lowerHex64(digest) {
		return ""
	}
	loop := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loop) {
		return ""
	}
	return u.Scheme + "://" + u.Host + "/dropbox/share/" + serverID + "/" + digest
}

// ShareView is what the Share dialog needs when no Dropbox is connected on this computer (#16109, coral-hub's differences #211076): whether Share goes through Coral Hub,
// the Hub's page to open, and whether the file looks like it holds a secret (then it waits for "Upload anyway" here). It offers nothing on a team's computer, with the
// switch off, with no enrolment, or for a file tagged internal. In v1 Coral only opens the Hub's page: no call from Coral to the Hub starts a share.
func (d *HubDropbox) ShareView(ctx context.Context, digest string, data []byte) map[string]any {
	no := map[string]any{"offered": false}
	if d == nil || d.Enrolment == nil || !d.enabled(ctx) {
		return no
	}
	if d.Internal != nil {
		if internal, err := d.Internal(ctx, digest); err != nil {
			return no
		} else if internal {
			return map[string]any{"offered": false, "blocked": "internal"}
		}
	}
	hubURL, serverID, err := d.Enrolment(ctx)
	if err != nil {
		return no
	}
	page := hubSharePage(hubURL, serverID, digest)
	if page == "" {
		return no
	}
	f, err := hubdropbox.ReadOnce(bytes.NewReader(data))
	return map[string]any{"offered": true, "url": page, "flagged": err != nil || f.Flagged}
}
