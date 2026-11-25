package routes

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// A second Hub joins a computer (#21220, design B): this self-hosted Hub holds a request key the computer made (`coral cloud keys create`, typed in by the person, or made over SSH for a
// computer set up by sshprov), asks the computer to join with it at a level (view, interact, launch), waits for the person there to Allow, and finishes with the 8-digit code that person reads
// off their screen and types in here. The finish turns the key into a key link on that computer, and the hub registers the computer with the key (store.AddLinkKey): from then on the key
// reaches it at the level that person gave. The Hub-side join is three routes, all the Operator's, all in person:
//
//	POST /api/servers/join             {id, label?, url, cap, allow_private?, hub?, key | ssh_target}   -> {join, state}
//	GET  /api/servers/join/{join}                                                                       -> {state}   (pending, allowed, denied, expired, linked)
//	POST /api/servers/join/{join}/code {code}                                                           -> the registered server
//
// The key, the computer's request id and its poll secret live only in this process's memory while a join waits, and in the sealed server record after; never in a log, a reply or a URL.

// keyJoinTTL is how long a join waits for its person (the computer's own request lasts as long: store.LinkRequestPendingTTL).
const keyJoinTTL = store.LinkRequestPendingTTL

// maxKeyJoins is how many joins may wait at once.
const maxKeyJoins = 8

// maxJoinCodeTries is how many wrong codes one join may send before it ends here (coral-hub Security's SHOULD C on #21220). The computer keeps its own count and denies its request after
// store.LinkRequestMaxTries wrong codes, whatever any Hub does.
const maxJoinCodeTries = 5

type keyJoin struct {
	serverID, label, url string
	allowPrivate         bool
	key                  string // the request key: for the three calls and the record, nowhere else
	requestID, secret    string // the computer's request and its poll secret
	expires              time.Time
	tries                int // wrong codes sent so far
}

type keyJoins struct {
	mu sync.Mutex
	m  map[string]*keyJoin
}

func (j *keyJoins) get(id string) *keyJoin {
	j.mu.Lock()
	defer j.mu.Unlock()
	kj := j.m[id]
	if kj != nil && time.Now().After(kj.expires) {
		delete(j.m, id)
		return nil
	}
	return kj
}

func (j *keyJoins) put(kj *keyJoin) (string, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.m == nil {
		j.m = map[string]*keyJoin{}
	}
	for id, o := range j.m {
		if time.Now().After(o.expires) {
			delete(j.m, id)
		}
	}
	if len(j.m) >= maxKeyJoins {
		return "", false
	}
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	j.m[id] = kj
	return id, true
}

// wrongCode counts one wrong code for join id and reports whether it may still try; at maxJoinCodeTries the join ends.
func (j *keyJoins) wrongCode(id string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	kj := j.m[id]
	if kj == nil {
		return false
	}
	kj.tries++
	if kj.tries >= maxJoinCodeTries {
		delete(j.m, id)
		return false
	}
	return true
}

func (j *keyJoins) drop(id string) {
	j.mu.Lock()
	delete(j.m, id)
	j.mu.Unlock()
}

// SSHLinkKeyMaker makes a request key on a computer set up over SSH: `coral cloud keys create <name>` with the latest Coral installed there (sshprov.Runner.CreateLinkKey).
type SSHLinkKeyMaker func(ctx context.Context, sshTarget, name string) (string, error)

// SSHCreateLinkKey is the SSHLinkKeyMaker of the owner's own SSH access.
func SSHCreateLinkKey(ctx context.Context, sshTarget, name string) (string, error) {
	t, err := sshTargetOf(sshTarget)
	if err != nil {
		return "", err
	}
	r := sshprov.Runner{}
	v, err := r.LatestInstalled(ctx, t)
	if err != nil {
		return "", err
	}
	return r.CreateLinkKey(ctx, t, v, name)
}

// SetSSHLinkKeyMaker sets how a join makes its key over SSH (tests give a fake; nil: SSH joins are refused).
func (h *RemoteServersHandler) SetSSHLinkKeyMaker(f SSHLinkKeyMaker) { h.sshKey = f }

// keyNameUnsafe is every character a key name may not hold (sshprov's linkKeyNameRe).
var keyNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9 ._-]`)

// keyNameFor names the key this hub makes over SSH after this hub's own address, so the computer's person sees which Hub it is in their key list.
func keyNameFor(hub string) string {
	n := strings.TrimPrefix(strings.TrimPrefix(hub, "https://"), "http://")
	n = strings.Trim(keyNameUnsafe.ReplaceAllString(n, "-"), " ._-")
	if len(n) > 40 {
		n = n[:40]
	}
	if n == "" {
		n = "hub"
	}
	return n
}

// sshFailureText is what an SSH failure may show the person (coral-hub Security's SHOULD A on #21220): no key and no long hex (a key's secret, a host key), at most 200 characters.
var sshSecretish = regexp.MustCompile(`lrk_[0-9A-Za-z_]*|[0-9a-fA-F]{16,}`)

func sshFailureText(err error) string {
	s := sshSecretish.ReplaceAllString(cleanSavedField(err.Error()), "[hidden]")
	if len(s) > 200 {
		s = s[:200] + "..."
	}
	return s
}

// orphanedKeyNote names a key this hub made over SSH for a join that then failed (coral-hub Security's SHOULD B on #21220): it is unused at that computer, and the person removes it there. Only
// its id, which is not a secret.
func orphanedKeyNote(key string) string {
	rest := strings.TrimPrefix(key, "lrk_")
	id, _, ok := strings.Cut(rest, "_")
	if !ok || len(id) != 8 {
		return ""
	}
	return " The request key lk-" + id + " this hub made on that computer is unused: remove it there with: coral cloud keys revoke lk-" + id
}

// thisHubOrigin is this hub's address as the person's browser reached it: the name the computer shows its person and holds the link under.
func thisHubOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// joinPerson refuses a caller that is not the person at this hub (an agent's token, a script with the API key).
func joinPerson(w http.ResponseWriter, r *http.Request) bool {
	if !humanInputCaller(r) {
		errForbidden(w, "Only the person at this hub can join a computer")
		return false
	}
	return true
}

// remoteCall sends one join call to the computer through the same guarded target the proxy uses (its SSRF checks, the request key in its own header and only over https or loopback).
func remoteCall(ctx context.Context, t proxy.HTTPTarget, method, path string, body any, hdr map[string]string) (int, map[string]any, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://remote"+path, rd)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := t.RoundTrip(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out)
	return resp.StatusCode, out, nil
}

// remoteSaid is the computer's own words for a refusal (its error text, cleaned), or a plain sentence when it gave none.
func remoteSaid(code int, out map[string]any) string {
	for _, k := range []string{"error", "detail"} {
		if s, ok := out[k].(string); ok && strings.TrimSpace(s) != "" {
			return "The computer said: " + cleanSavedField(s)
		}
	}
	return "The computer answered " + http.StatusText(code)
}

// joinErr answers a join that could not reach the computer: the reason, never the key.
func joinErr(w http.ResponseWriter, err error) { joinErrNote(w, err, "") }

// joinErrNote is joinErr with a note after the reason (an orphaned key's).
func joinErrNote(w http.ResponseWriter, err error, note string) {
	switch {
	case errors.Is(err, proxy.ErrLinkKeyPlainHTTP):
		errBadRequest(w, proxy.ErrLinkKeyPlainHTTP.Error()+note)
	case errors.Is(err, proxy.ErrBlocked):
		errBadRequest(w, "That address is on a private network: tick Allow a private address to join it."+note)
	default:
		writeError(w, http.StatusBadGateway, "unreachable", "Could not reach the computer."+note)
	}
}

// JoinStart handles POST /api/servers/join.
func (h *RemoteServersHandler) JoinStart(w http.ResponseWriter, r *http.Request) {
	if !joinPerson(w, r) || !requireJSON(w, r) {
		return
	}
	var body struct {
		ID           string `json:"id"`
		Label        string `json:"label"`
		URL          string `json:"url"`
		Cap          string `json:"cap"`
		AllowPrivate bool   `json:"allow_private"`
		Hub          string `json:"hub"`
		Key          string `json:"key"`
		SSHTarget    string `json:"ssh_target"`
	}
	if err := decodeJSONLimit(r, &body, 8192); err != nil {
		errBadRequest(w, "send {id, url, cap, and key or ssh_target}")
		return
	}
	if err := store.ValidateRemoteID(body.ID); err != nil {
		errBadRequest(w, err.Error())
		return
	}
	if body.Cap != "view" && body.Cap != "interact" && body.Cap != "launch" {
		errBadRequest(w, "cap must be view, interact or launch")
		return
	}
	norm, err := validateRemoteURL(body.URL, body.AllowPrivate)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	if !proxy.KeySafeURL(norm) {
		errBadRequest(w, proxy.ErrLinkKeyPlainHTTP.Error())
		return
	}
	if _, err := h.store.Get(r.Context(), body.ID); err == nil {
		remoteErr(w, store.ErrRemoteExists)
		return
	}
	hub := strings.TrimSpace(body.Hub)
	if hub == "" {
		hub = thisHubOrigin(r)
	}
	key := strings.TrimSpace(body.Key)
	made := "" // a key this hub made over SSH: named as unused if the join fails after it
	switch {
	case key != "" && body.SSHTarget != "":
		errBadRequest(w, "send a key or an ssh_target, not both")
		return
	case key == "" && body.SSHTarget == "":
		errBadRequest(w, "send the computer's request key, or the SSH target to make one with")
		return
	case key == "":
		if h.sshKey == nil {
			errBadRequest(w, "this hub cannot make a key over SSH")
			return
		}
		if key, err = h.sshKey(r.Context(), body.SSHTarget, keyNameFor(hub)); err != nil {
			slog.Warn("hub: could not make a request key over SSH", "server", body.ID, "error", sshFailureText(err))
			writeError(w, http.StatusBadGateway, "ssh_key_failed", "Could not make a request key on that computer over SSH: "+sshFailureText(err))
			return
		}
		made = key
	}
	if !proxy.IsLinkKey(key) {
		errBadRequest(w, "that is not a request key (it starts with lrk_): make one at the computer with coral cloud keys create")
		return
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = body.ID
	}
	t := proxy.HTTPTarget{URL: norm, APIKey: key, AllowPrivate: body.AllowPrivate}
	orphan := ""
	if made != "" {
		orphan = orphanedKeyNote(made)
	}
	ask := map[string]string{"hub": hub, "cap": body.Cap}
	if id := HubLinkID(); hubowner.ValidHubID(id) {
		ask["hub_id"] = id // which hub this is, so the computer binds this key link's owner stamps to this hub's own secret only (#21261); an older computer ignores the field
	}
	code, out, err := remoteCall(r.Context(), t, http.MethodPost, "/api/cloud/link-requests", ask, nil)
	if err != nil {
		joinErrNote(w, err, orphan)
		return
	}
	reqID, _ := out["request_id"].(string)
	secret, _ := out["poll_secret"].(string)
	if code != http.StatusOK || reqID == "" || secret == "" {
		writeError(w, http.StatusBadGateway, "join_refused", remoteSaid(code, out)+"."+orphan)
		return
	}
	id, ok := h.joins.put(&keyJoin{serverID: body.ID, label: label, url: norm, allowPrivate: body.AllowPrivate, key: key, requestID: reqID, secret: secret, expires: time.Now().Add(keyJoinTTL)})
	if !ok {
		httputil.WriteActionLimit(w, 60, "too_many_joins", "Too many joins are waiting: finish or wait for them first."+orphan) // a per-action limit: marked, so the dashboard does not read it as an overloaded server
		return
	}
	slog.Info("hub: asked a computer to join", "server", body.ID, "join", id)
	writeJSON(w, http.StatusOK, map[string]string{"join": id, "state": "pending"})
}

// JoinStatus handles GET /api/servers/join/{join}: whether the computer's person has answered.
func (h *RemoteServersHandler) JoinStatus(w http.ResponseWriter, r *http.Request) {
	if !joinPerson(w, r) {
		return
	}
	kj := h.joins.get(chi.URLParam(r, "join"))
	if kj == nil {
		errNotFound(w, "No such join (it may have expired: start again)")
		return
	}
	t := proxy.HTTPTarget{URL: kj.url, APIKey: kj.key, AllowPrivate: kj.allowPrivate}
	code, out, err := remoteCall(r.Context(), t, http.MethodGet, "/api/cloud/link-requests/"+kj.requestID, nil, map[string]string{linkRequestSecretHeader: kj.secret})
	if err != nil {
		joinErr(w, err)
		return
	}
	st, _ := out["state"].(string)
	if code != http.StatusOK || st == "" {
		writeError(w, http.StatusBadGateway, "join_refused", remoteSaid(code, out))
		return
	}
	reply := map[string]string{"state": cleanSavedField(st)}
	if c, _ := out["cap"].(string); joinCapOK(c) {
		reply["cap"] = c // what the person allowed, shown before the code is typed (#21221)
	}
	writeJSON(w, http.StatusOK, reply)
}

// JoinCode handles POST /api/servers/join/{join}/code {code}: finishes the join as a key link at the computer, then registers it here with the key.
func (h *RemoteServersHandler) JoinCode(w http.ResponseWriter, r *http.Request) {
	if !joinPerson(w, r) || !requireJSON(w, r) {
		return
	}
	jid := chi.URLParam(r, "join")
	kj := h.joins.get(jid)
	if kj == nil {
		errNotFound(w, "No such join (it may have expired: start again)")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSONLimit(r, &body, 1024); err != nil || !eightDigits.MatchString(strings.TrimSpace(body.Code)) {
		errBadRequest(w, "send {code}: the 8 digits the computer shows")
		return
	}
	t := proxy.HTTPTarget{URL: kj.url, APIKey: kj.key, AllowPrivate: kj.allowPrivate}
	code, out, err := remoteCall(r.Context(), t, http.MethodPost, "/api/cloud/link-requests/"+kj.requestID+"/finish",
		map[string]string{"poll_secret": kj.secret, "code": strings.TrimSpace(body.Code), "link": "key"}, nil)
	if err != nil {
		joinErr(w, err)
		return
	}
	if linked, _ := out["linked"].(bool); code != http.StatusOK || !linked {
		if c, _ := out["code"].(string); code == http.StatusForbidden && c == "wrong_code" && !h.joins.wrongCode(jid) {
			writeError(w, http.StatusGone, "too_many_codes", "That was the last wrong code this hub sends for this join: start the join again")
			return
		}
		status := http.StatusBadGateway
		if code == http.StatusForbidden || code == http.StatusConflict || code == http.StatusGone {
			status = code // a wrong code, a request that is not waiting: the person can act on it
		}
		writeError(w, status, "join_refused", remoteSaid(code, out))
		return
	}
	h.joins.drop(jid)
	srv, err := h.store.AddLinkKey(r.Context(), kj.serverID, kj.label, kj.url, kj.key, kj.allowPrivate)
	if err != nil {
		remoteErr(w, err)
		return
	}
	h.store.SetStatus(r.Context(), srv.ID, store.RemoteStatusUnknown, "")
	if h.statusListener != nil {
		h.statusListener(srv.ID, store.RemoteStatusUnknown)
	}
	slog.Info("hub: joined a computer with a request key", "server", srv.ID)
	srv, _ = h.store.Get(r.Context(), srv.ID)
	given, _ := out["cap"].(string)
	if !joinCapOK(given) {
		given = ""
	}
	writeJSON(w, http.StatusCreated, struct {
		remoteServerView
		Cap string `json:"cap,omitempty"` // the level the person gave on that computer (#21221)
	}{viewRemote(srv), given})
}

// joinCapOK is whether c is one of the three levels a computer can give; anything else a computer sends is not passed on.
func joinCapOK(c string) bool { return c == "view" || c == "interact" || c == "launch" }

var eightDigits = regexp.MustCompile(`^\d{8}$`)
