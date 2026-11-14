package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14609, Dropbox stage 3a, piece 3: the Operator's Dropbox routes and the browser's return on the one-shot listener, against a fake Dropbox.

type fakeDropbox struct {
	mu          sync.Mutex
	account     string // the account the next code signs in as
	badCode     bool   // the token endpoint answers invalid_grant to the next code
	revokeFails bool
	revoked     int
	sameRefresh bool   // Dropbox answers a reconnect of the same account with the refresh token it gave before
	issued      int    // codes exchanged, so each sign-in gets its own refresh token by default
	onRevoke    func() // called when a revoke arrives, before it is answered (to check what is stored at that moment)
	refreshDead bool   // the token endpoint answers invalid_grant to a refresh
	// Stage 4's upload side.
	sessions      map[string][]byte
	files         map[string][]byte // path -> bytes stored
	finishCalls   int
	onStart       func() // called when an upload session starts (to change things mid-pass)
	used, alloc   int64
	rateLimitOnce int  // the next upload session start answers 429 with this Retry-After (seconds), once
	badHash       bool // finish_batch answers success with a content_hash that is not the bytes'
	srv           *httptest.Server
	// Stage 4b's delete side.
	revs        map[string]string   // a path's rev when it is not r1 (an edit in Dropbox)
	dateOffset  time.Duration       // Dropbox's clock, ahead of this one by this much
	noDate      bool                // answer get_space_usage with no Date header
	asyncPolls  int                 // delete_batch answers with a job that is in progress for this many checks
	jobs        map[string][]string // job id -> "path|parent_rev" of each entry
	deleteCalls [][]string          // the paths of each delete_batch call
	checkCalls  int
	// Stage 5a's listing and download side.
	changes        []map[string]any  // entries list_folder/continue answers after a cursor (an edit, a touch, a delete)
	revBytes       map[string][]byte // bytes of each rev an edit made
	pageSize       int               // entries a page (0: all)
	resetNext      bool              // the next continue answers reset
	downloads      []string          // revs downloaded
	lieSize        int64             // download answers this size in Dropbox-API-Result while sending the real bytes
	extraBytes     []byte            // download appends these to the body (a stream longer than declared)
	listCalls      int
	failDownloads  int  // the next downloads answer 500 (Dropbox's own trouble)
	markersFail    bool // stage 6a: a marker listing answers 500
	failDeletes    int  // the next delete_batch calls answer 500
	probeBad       bool // stage 6b: a probe reads back other bytes than were sent
	markerReadFail bool // stage 6b: reading a marker back answers not found
	// Share via Dropbox (#14944).
	links       map[string][]fakeLink // path -> its shared links
	members     map[string][]string   // file id -> emails it is shared with
	basic       bool                  // the account is basic (no link expiry)
	team        string                // the account's team ('' none)
	noScope     bool                  // sharing calls answer missing_scope (an older sign-in)
	copyBadHash bool                  // copy_v2 answers a content hash that is not the bytes'
	revokeFail  bool                  // revoke_shared_link answers 500
	membersFail bool                  // add_file_member refuses the member
	copies      int                   // copy_v2 calls
	folders     map[string][]string   // #16170: shared folder id -> the addresses of its members (list_folders, list_folder_members)
	foldersFail bool                  // list_folders refuses (a Dropbox that is down or rate-limited)
	folderCalls int                   // list_folders calls
	checkFail   string                // the sharing check (list_shared_links with no path) answers 409 with this summary
}

type fakeLink struct {
	url, aud, expires string
}

// edit replaces path's bytes as a person would in Dropbox (a new rev, a new content hash).
func (f *fakeDropbox) edit(path string, b []byte) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.revs == nil {
		f.revs = map[string]string{}
	}
	if f.revBytes == nil {
		f.revBytes = map[string][]byte{}
	}
	rev := fmt.Sprintf("e%d", len(f.revBytes)+1)
	f.files[path], f.revs[path], f.revBytes[rev] = b, rev, b
	f.changes = append(f.changes, map[string]any{".tag": "file", "path_lower": path, "rev": rev, "size": len(b), "content_hash": dropbox.ContentHash(b)})
	return rev
}

// touch gives path a new rev with the same bytes.
func (f *fakeDropbox) touch(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.revs == nil {
		f.revs = map[string]string{}
	}
	b := f.files[path]
	rev := fmt.Sprintf("t%d", len(f.changes)+1)
	f.revs[path] = rev
	f.changes = append(f.changes, map[string]any{".tag": "file", "path_lower": path, "rev": rev, "size": len(b), "content_hash": dropbox.ContentHash(b)})
}

// remove deletes path in Dropbox, as a person would.
func (f *fakeDropbox) remove(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.files, path)
	f.changes = append(f.changes, map[string]any{".tag": "deleted", "path_lower": path})
}

// listPage answers entries[from:] a page at a time with cursor "c<next>".
func (f *fakeDropbox) listPage(entries []map[string]any, from int) map[string]any {
	end := len(entries)
	if f.pageSize > 0 && from+f.pageSize < end {
		end = from + f.pageSize
	}
	page := entries[from:end]
	if page == nil {
		page = []map[string]any{}
	}
	return map[string]any{"entries": page, "cursor": fmt.Sprintf("c%d", end), "has_more": end < len(entries)}
}

// applyDeletes deletes each "path|parent_rev" whose rev still matches, as Dropbox does: a missing path is not_found, another rev is refused.
func (f *fakeDropbox) applyDeletes(keyed []string) []any {
	var out []any
	for _, k := range keyed {
		path, rev, _ := strings.Cut(k, "|")
		if rev == "" { // stage 6a: a folder, deleted whole (no parent_rev)
			n := 0
			for p := range f.files {
				if p == path || strings.HasPrefix(p, path+"/") {
					delete(f.files, p)
					n++
				}
			}
			if n == 0 {
				out = append(out, map[string]any{".tag": "failure", "failure": map[string]any{".tag": "path_lookup", "path_lookup": map[string]any{".tag": "not_found"}}})
			} else {
				out = append(out, map[string]any{".tag": "success", "metadata": map[string]any{".tag": "folder", "path_lower": path}})
			}
			continue
		}
		cur := "r1"
		if r, ok := f.revs[path]; ok {
			cur = r
		}
		switch _, there := f.files[path]; {
		case !there:
			out = append(out, map[string]any{".tag": "failure", "failure": map[string]any{".tag": "path_lookup", "path_lookup": map[string]any{".tag": "not_found"}}})
		case rev != cur:
			out = append(out, map[string]any{".tag": "failure", "failure": map[string]any{".tag": "path_write", "path_write": map[string]any{".tag": "conflict", "conflict": map[string]any{".tag": "file"}}}})
		default:
			delete(f.files, path)
			out = append(out, map[string]any{".tag": "success", "metadata": map[string]any{".tag": "file", "path_lower": path}})
		}
	}
	return out
}

func newFakeDropbox(t *testing.T) *fakeDropbox {
	f := &fakeDropbox{account: "dbid:AAA", sessions: map[string][]byte{}, files: map[string][]byte{}, used: 0, alloc: 1 << 40}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/oauth2/token":
			_ = r.ParseForm()
			if r.PostForm.Get("grant_type") == "authorization_code" {
				if f.badCode {
					w.WriteHeader(http.StatusBadRequest)
					w.Write([]byte(`{"error":"invalid_grant"}`))
					return
				}
				f.issued++
				refresh := fmt.Sprintf("refresh-secret-%s-%d", f.account, f.issued)
				if f.sameRefresh {
					refresh = "refresh-secret-" + f.account
				}
				json.NewEncoder(w).Encode(map[string]any{"access_token": "a-" + f.account, "refresh_token": refresh, "account_id": f.account, "expires_in": 14400})
				return
			}
			if f.refreshDead {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "a1", "expires_in": 14400})
		case "/2/files/upload_session/start":
			if f.onStart != nil {
				f.mu.Unlock()
				f.onStart()
				f.mu.Lock()
			}
			if f.rateLimitOnce > 0 {
				w.Header().Set("Retry-After", fmt.Sprint(f.rateLimitOnce))
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprintf(w, `{"error_summary":"too_many_requests/","error":{"reason":{".tag":"too_many_requests"},"retry_after":%d}}`, f.rateLimitOnce)
				f.rateLimitOnce = 0
				return
			}
			b, _ := io.ReadAll(r.Body)
			id := fmt.Sprintf("s%d", len(f.sessions)+1)
			f.sessions[id] = b
			json.NewEncoder(w).Encode(map[string]string{"session_id": id})
		case "/2/files/upload_session/finish_batch_v2":
			f.finishCalls++
			var a struct {
				Entries []struct {
					Cursor struct {
						SessionID string `json:"session_id"`
					} `json:"cursor"`
					Commit struct {
						Path string `json:"path"`
						Mode string `json:"mode"`
					} `json:"commit"`
				} `json:"entries"`
			}
			json.NewDecoder(r.Body).Decode(&a)
			var out []any
			for _, e := range a.Entries {
				if _, there := f.files[e.Commit.Path]; there || e.Commit.Mode != "add" {
					out = append(out, map[string]any{".tag": "failure", "failure": map[string]any{".tag": "path", "path": map[string]any{".tag": "conflict"}}})
					continue
				}
				b := f.sessions[e.Cursor.SessionID]
				f.files[e.Commit.Path] = b
				hash := dropbox.ContentHash(b)
				if f.badHash {
					hash = dropbox.ContentHash(append([]byte("not "), b...))
				}
				rev := "r1"
				if strings.HasPrefix(e.Commit.Path, "/v1/probe/") { // stage 6b's probe: its own rev, readable by Download
					rev = "probe-" + strings.TrimPrefix(e.Commit.Path, "/v1/probe/")
					if f.revs == nil {
						f.revs = map[string]string{}
					}
					if f.revBytes == nil {
						f.revBytes = map[string][]byte{}
					}
					f.revs[e.Commit.Path], f.revBytes[rev] = rev, b
					if f.probeBad {
						f.revBytes[rev] = append([]byte("not "), b...)
					}
				}
				out = append(out, map[string]any{".tag": "success", "id": "id:" + e.Commit.Path, "rev": rev, "content_hash": hash})
			}
			json.NewEncoder(w).Encode(map[string]any{"entries": out})
		case "/2/files/get_metadata":
			var a map[string]string
			json.NewDecoder(r.Body).Decode(&a)
			if f.markerReadFail && strings.HasPrefix(a["path"], "/v1/offloaded/") { // stage 6b: a marker written but not read back
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"path/not_found/"}`))
				return
			}
			b, ok := f.files[a["path"]]
			if !ok {
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"path/not_found/"}`))
				return
			}
			rev := "r1"
			if v, ok := f.revs[a["path"]]; ok {
				rev = v // the rev an edit made
			}
			json.NewEncoder(w).Encode(map[string]any{".tag": "file", "id": "id:" + a["path"], "rev": rev, "content_hash": dropbox.ContentHash(b)})
		case "/2/files/list_folder":
			f.listCalls++
			var la map[string]any
			_ = json.NewDecoder(r.Body).Decode(&la)
			if lp, _ := la["path"].(string); strings.HasPrefix(lp, "/v1/offloaded/") || strings.HasPrefix(lp, "/v1/probe/") || strings.HasPrefix(lp, "/Shared from Coral/") { // one folder, by name: 6a's markers, 6b's probe, #14944's shared folder
				if f.markersFail {
					w.WriteHeader(http.StatusInternalServerError)
					w.Write([]byte(`{"error_summary":"internal_error/"}`))
					return
				}
				var ents []map[string]any
				for p := range f.files {
					if strings.HasPrefix(p, lp+"/") && !strings.Contains(strings.TrimPrefix(p, lp+"/"), "/") {
						ents = append(ents, map[string]any{".tag": "file", "name": strings.TrimPrefix(p, lp+"/"), "path_lower": p})
					}
				}
				if len(ents) == 0 {
					w.WriteHeader(http.StatusConflict)
					w.Write([]byte(`{"error_summary":"path/not_found/"}`))
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"entries": ents, "cursor": "m", "has_more": false})
				return
			}
			if lp, _ := la["path"].(string); lp == "/v1/offloaded" && f.markersFail { // stage 6b: retention's marker listing fails
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error_summary":"internal_error/"}`))
				return
			}
			// A full listing: every file stored, with the changes made so far counted as seen (the cursor points after them).
			var all []map[string]any
			for p, b := range f.files {
				rev := "r1"
				if v, ok := f.revs[p]; ok {
					rev = v
				}
				all = append(all, map[string]any{".tag": "file", "path_lower": p, "rev": rev, "size": len(b), "content_hash": dropbox.ContentHash(b)})
			}
			sort.Slice(all, func(i, j int) bool { return all[i]["path_lower"].(string) < all[j]["path_lower"].(string) })
			out := f.listPage(all, 0)
			if !out["has_more"].(bool) {
				out["cursor"] = fmt.Sprintf("c%d", len(f.changes))
			} else {
				out["cursor"] = fmt.Sprintf("L%d", len(out["entries"].([]map[string]any)))
			}
			json.NewEncoder(w).Encode(out)
		case "/2/files/list_folder/continue":
			f.listCalls++
			var a map[string]string
			json.NewDecoder(r.Body).Decode(&a)
			if f.resetNext {
				f.resetNext = false
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"reset/.."}`))
				return
			}
			var from int
			if _, err := fmt.Sscanf(a["cursor"], "L%d", &from); err == nil { // the rest of a full listing
				var all []map[string]any
				for p, b := range f.files {
					all = append(all, map[string]any{".tag": "file", "path_lower": p, "rev": "r1", "size": len(b), "content_hash": dropbox.ContentHash(b)})
				}
				sort.Slice(all, func(i, j int) bool { return all[i]["path_lower"].(string) < all[j]["path_lower"].(string) })
				out := f.listPage(all, from)
				if out["has_more"].(bool) {
					out["cursor"] = fmt.Sprintf("L%d", from+len(out["entries"].([]map[string]any)))
				} else {
					out["cursor"] = fmt.Sprintf("c%d", len(f.changes))
				}
				json.NewEncoder(w).Encode(out)
				return
			}
			fmt.Sscanf(a["cursor"], "c%d", &from)
			json.NewEncoder(w).Encode(f.listPage(f.changes, from))
		case "/2/files/download":
			var a map[string]string
			json.Unmarshal([]byte(r.Header.Get("Dropbox-API-Arg")), &a)
			rev := strings.TrimPrefix(a["path"], "rev:")
			f.downloads = append(f.downloads, rev) // every attempt, answered or not
			if f.failDownloads > 0 {
				f.failDownloads--
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error_summary":"internal_error/"}`))
				return
			}
			b, ok := f.revBytes[rev]
			if !ok {
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"path/not_found/"}`))
				return
			}
			size := int64(len(b))
			if f.lieSize > 0 {
				size = f.lieSize
			}
			w.Header().Set("Dropbox-API-Result", fmt.Sprintf(`{"rev":%q,"size":%d,"content_hash":%q}`, rev, size, dropbox.ContentHash(b)))
			if len(f.extraBytes) > 0 {
				w.(http.Flusher).Flush()
			}
			w.Write(b)
			w.Write(f.extraBytes)
		case "/2/files/delete_batch":
			if f.failDeletes > 0 { // Dropbox's own trouble on a delete (QA's survivor b on #14814)
				f.failDeletes--
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error_summary":"internal_error/"}`))
				return
			}
			var a struct {
				Entries []struct {
					Path      string `json:"path"`
					ParentRev string `json:"parent_rev"`
				} `json:"entries"`
			}
			json.NewDecoder(r.Body).Decode(&a)
			var paths, keyed []string
			for _, e := range a.Entries {
				paths = append(paths, e.Path)
				keyed = append(keyed, e.Path+"|"+e.ParentRev)
			}
			f.deleteCalls = append(f.deleteCalls, paths)
			if f.asyncPolls > 0 {
				if f.jobs == nil {
					f.jobs = map[string][]string{}
				}
				id := fmt.Sprintf("job-%d", len(f.deleteCalls))
				f.jobs[id] = keyed
				json.NewEncoder(w).Encode(map[string]any{".tag": "async_job_id", "async_job_id": id})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{".tag": "complete", "entries": f.applyDeletes(keyed)})
		case "/2/files/delete_batch/check":
			f.checkCalls++
			var a map[string]string
			json.NewDecoder(r.Body).Decode(&a)
			keyed, ok := f.jobs[a["async_job_id"]]
			if !ok {
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"invalid_async_job_id/"}`))
				return
			}
			if f.asyncPolls > 0 {
				f.asyncPolls--
				json.NewEncoder(w).Encode(map[string]any{".tag": "in_progress"})
				return
			}
			delete(f.jobs, a["async_job_id"])
			json.NewEncoder(w).Encode(map[string]any{".tag": "complete", "entries": f.applyDeletes(keyed)})
		case "/2/files/copy_v2", "/2/users/get_current_account", "/2/sharing/add_file_member", "/2/sharing/create_shared_link_with_settings",
			"/2/sharing/list_shared_links", "/2/sharing/revoke_shared_link", "/2/sharing/unshare_file", "/2/sharing/list_folders", "/2/sharing/list_folder_members":
			f.sharing(w, r)
		case "/2/users/get_space_usage":
			if f.noDate {
				w.Header()["Date"] = nil // net/http adds a Date unless it is set to nil
			} else {
				w.Header().Set("Date", time.Now().Add(f.dateOffset).UTC().Format(http.TimeFormat))
			}
			json.NewEncoder(w).Encode(map[string]any{"used": f.used, "allocation": map[string]any{"allocated": f.alloc}})
		case "/2/auth/token/revoke":
			if f.onRevoke != nil {
				f.mu.Unlock()
				f.onRevoke()
				f.mu.Lock()
			}
			if f.revokeFails {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			f.revoked++
			w.Write([]byte("null"))
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type dropboxEnv struct {
	lastAuthorize string // the authorize URL of the last signIn (#15638: a test reads its client_id)
	t             *testing.T
	h             *CloudHandler
	dbx           *fakeDropbox
	machine       string
	machMu        sync.Mutex // machine is read by the worker and may be changed by a hook in the fake Dropbox's handlers (#14980)
	host          string     // the Host the dashboard was opened at
	db            *store.DB
	body          string // the next call's JSON body ('{}' when empty)
}

func newDropboxEnv(t *testing.T) *dropboxEnv {
	t.Helper()
	dir := t.TempDir()
	db, err := storetest.Open(t, filepath.Join(dir, "c.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewCloudHandler(store.NewSessionStore(db), dir)
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	h.SetDropbox(store.NewDropboxStore(db, store.NewRemoteServerStore(db, dir)), dir)
	e := &dropboxEnv{t: t, h: h, dbx: newFakeDropbox(t), machine: "machine-1", host: "127.0.0.1:8420", db: db}
	h.dbx.appKey = func() string { return "appkey" }
	h.dbx.client = func(k string) *dropbox.Client { return dropbox.NewClientAt(k, e.dbx.srv.URL) }
	h.dbx.machineID = func() (string, error) { e.machMu.Lock(); defer e.machMu.Unlock(); return e.machine, nil }
	h.dbx.port = 0
	return e
}

// setMachine changes this computer's machine id, under the lock (a hook may do it while the worker reads it).
func (e *dropboxEnv) setMachine(id string) {
	e.machMu.Lock()
	defer e.machMu.Unlock()
	e.machine = id
}

func (e *dropboxEnv) call(method, path string, dashboard bool, hdr map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	body := `{}`
	if e.body != "" {
		body, e.body = e.body, ""
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if dashboard {
		dashboardRequest(req)
		req.Host = e.host
	}
	rec := httptest.NewRecorder()
	switch path {
	case "/api/dropbox/status":
		e.h.DropboxStatus(rec, req)
	case "/api/dropbox/connect":
		e.h.DropboxConnect(rec, req)
	case "/api/dropbox/disconnect":
		e.h.DropboxDisconnect(rec, req)
	case "/api/dropbox/switch":
		e.h.DropboxConfirmSwitch(rec, req)
	case "/api/dropbox/takeover":
		e.h.DropboxTakeOver(rec, req)
	case "/api/dropbox/check":
		e.h.DropboxCheckAgain(rec, req)
	case "/api/dropbox/retention":
		e.h.DropboxSetRetention(rec, req)
	case "/api/dropbox/app-key":
		e.h.DropboxSetAppKey(rec, req)
	}
	return rec
}

func (e *dropboxEnv) status() map[string]any {
	e.t.Helper()
	rec := e.call(http.MethodGet, "/api/dropbox/status", true, nil)
	require.Equal(e.t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(e.t, rec.Body.String(), "refresh-secret", "the status never carries the token")
	var m map[string]any
	require.NoError(e.t, json.Unmarshal(rec.Body.Bytes(), &m))
	return m
}

// signIn starts a sign-in and comes back as a browser would: with the flow cookie (binding "" means keep the real one) and the state from the URL.
// "Share through Coral Hub" (#16109): the status carries the local switch so Settings can draw it. Off by default, on only for the word true, and a
// value that is not exactly true (a typo, another case) reads as off.
func TestDropboxStatus_HubShareSwitch(t *testing.T) {
	e := newDropboxEnv(t)
	assert.Equal(t, false, e.status()["hub_share"], "off by default")
	require.NoError(t, e.h.ss.SetSetting(t.Context(), HubDropboxShareSetting, "true"))
	assert.Equal(t, true, e.status()["hub_share"], "on after the switch is turned on")
	require.NoError(t, e.h.ss.SetSetting(t.Context(), HubDropboxShareSetting, "yes"))
	assert.Equal(t, false, e.status()["hub_share"], "anything but true is off")
}

func (e *dropboxEnv) signIn(binding string) string {
	e.t.Helper()
	rec := e.call(http.MethodPost, "/api/dropbox/connect", true, nil)
	require.Equal(e.t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]string
	require.NoError(e.t, json.Unmarshal(rec.Body.Bytes(), &out))
	e.lastAuthorize = out["authorize_url"]
	u, err := url.Parse(out["authorize_url"])
	require.NoError(e.t, err)
	q := u.Query()
	cookie := ""
	for _, c := range rec.Result().Cookies() {
		if c.Name == dropbox.FlowCookie {
			cookie = c.Value
			assert.True(e.t, c.HttpOnly)
			assert.Equal(e.t, dropbox.CallbackPath, c.Path)
		}
	}
	require.NotEmpty(e.t, cookie)
	if binding != "" {
		cookie = binding
	}
	req, _ := http.NewRequest(http.MethodGet, q.Get("redirect_uri")+"?code=the-code&state="+url.QueryEscape(q.Get("state")), nil)
	req.AddCookie(&http.Cookie{Name: dropbox.FlowCookie, Value: cookie})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func TestTheDropboxRoutesAreTheOperatorsOnly(t *testing.T) {
	e := newDropboxEnv(t)
	for _, p := range []string{"/api/dropbox/status", "/api/dropbox/connect", "/api/dropbox/disconnect", "/api/dropbox/switch", "/api/dropbox/takeover"} {
		m := http.MethodPost
		if strings.HasSuffix(p, "status") {
			m = http.MethodGet
		}
		assert.Equal(t, http.StatusForbidden, e.call(m, p, false, nil).Code, "%s without the dashboard (an agent, a script)", p)
		assert.Equal(t, http.StatusForbidden, e.call(m, p, true, map[string]string{tunnel.ViaHeader: "1"}).Code, "%s through the tunnel", p)
	}
}

func TestConnectWithoutAnAppKeyIsRefused(t *testing.T) {
	e := newDropboxEnv(t)
	e.h.dbx.appKey = func() string { return "" }
	rec := e.call(http.MethodPost, "/api/dropbox/connect", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "no_app_key")
	assert.Equal(t, false, e.status()["app_key_set"])
}

func TestASignInConnectsAndTheStatusNeverCarriesTheToken(t *testing.T) {
	e := newDropboxEnv(t)
	assert.Equal(t, false, e.status()["connected"])
	assert.Contains(t, e.signIn(""), "Connected")
	st := e.status()
	assert.Equal(t, true, st["connected"])
	assert.Equal(t, "dbid:AAA", st["account_id"])
	assert.Equal(t, false, st["looks_like_copy"])
}

func TestASignInFinishedFromAnotherBrowserChangesNothing(t *testing.T) {
	e := newDropboxEnv(t)
	assert.Contains(t, e.signIn("someone-elses-cookie"), "didn't finish")
	assert.Equal(t, false, e.status()["connected"])
}

func TestAFailedExchangeDeletesNothing(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	e.dbx.badCode = true
	assert.Contains(t, e.signIn(""), "didn't finish")
	st := e.status()
	assert.Equal(t, true, st["connected"], "an invalid_grant on a code is a bad code, not a revoked sign-in")
	assert.Equal(t, "dbid:AAA", st["account_id"])
}

func TestAnotherAccountWaitsForTheOperatorsConfirm(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	require.Equal(t, http.StatusOK, e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil).Code)
	e.dbx.account = "dbid:BBB"
	assert.Contains(t, e.signIn(""), "different Dropbox account")
	st := e.status()
	assert.Equal(t, false, st["connected"], "nothing is saved before the confirm")
	assert.Equal(t, map[string]any{"from": "dbid:AAA", "to": "dbid:BBB"}, st["switch_pending"])
	rec := e.call(http.MethodPost, "/api/dropbox/switch", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	st = e.status()
	assert.Equal(t, true, st["connected"])
	assert.Equal(t, "dbid:BBB", st["account_id"])
	assert.Equal(t, http.StatusConflict, e.call(http.MethodPost, "/api/dropbox/switch", true, nil).Code, "nothing waits any more")
}

func TestDisconnectRevokesFirstAndClearsEvenIfTheRevokeFails(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	rec := e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"revoked":true`)
	assert.Equal(t, 1, e.dbx.revoked)
	assert.Equal(t, false, e.status()["connected"])

	require.Contains(t, e.signIn(""), "Connected")
	e.dbx.revokeFails = true
	rec = e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"revoked":false`, "it says the revoke failed")
	assert.Equal(t, false, e.status()["connected"], "and forgets the sign-in here anyway")
}

func TestACopyOnAnotherMachineLooksLikeACopyUntilTakeOver(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	assert.Equal(t, false, e.status()["looks_like_copy"])
	e.setMachine("machine-2")
	assert.Equal(t, true, e.status()["looks_like_copy"], "the data folder was started on another computer")
	require.Equal(t, http.StatusOK, e.call(http.MethodPost, "/api/dropbox/takeover", true, nil).Code)
	assert.Equal(t, false, e.status()["looks_like_copy"])
}

func TestAnUnreadableMachineIDStillWorks(t *testing.T) {
	e := newDropboxEnv(t)
	e.h.dbx.machineID = func() (string, error) { return "", errors.New("no id") }
	assert.Contains(t, e.signIn(""), "Connected", "the copy check falls back to the data folder")
}

// The flow cookie is set by the host the dashboard was opened at and the browser sends it only to that host: opened at localhost, it would never
// reach the 127.0.0.1 callback and the sign-in could not finish (Security's note 4 on #14638).
func TestConnectNeedsCoralOpenAt127(t *testing.T) {
	e := newDropboxEnv(t)
	e.host = "localhost:8420"
	rec := e.call(http.MethodPost, "/api/dropbox/connect", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "open_on_127")
	assert.Contains(t, rec.Body.String(), "http://127.0.0.1:8420")
	assert.False(t, e.h.dbx.flows.Pending(), "no sign-in was started")
}

// A sign-in that replaces a stored one revokes the old token at Dropbox first, best effort (Security's note 5 on #14638).
func TestANewSignInRevokesTheOneItReplaces(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	assert.Equal(t, 0, e.dbx.revoked)
	require.Contains(t, e.signIn(""), "Connected", "the same account again")
	assert.Equal(t, 1, e.dbx.revoked, "the replaced sign-in was revoked")

	e.dbx.account = "dbid:BBB"
	require.Contains(t, e.signIn(""), "different Dropbox account")
	assert.Equal(t, 1, e.dbx.revoked, "nothing is revoked before the confirm")
	rec := e.call(http.MethodPost, "/api/dropbox/switch", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"old_revoked":true`)
	assert.Equal(t, 2, e.dbx.revoked, "the switch revoked the old account's sign-in")

	e.dbx.revokeFails = true
	e.dbx.account = "dbid:BBB"
	assert.Contains(t, e.signIn(""), "Connected", "a failed revoke never blocks the new sign-in")
	assert.Equal(t, "dbid:BBB", e.status()["account_id"])
}

// The old sign-in is revoked only after the new one is saved (Security's SHOULD b on #14640): at the moment Dropbox gets the revoke, the store
// already holds the new token, so a failure between the two steps never leaves Coral with neither.
func TestTheOldSignInIsRevokedOnlyAfterTheNewOneIsSaved(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	first, err := e.h.dbx.store.RefreshToken(context.Background())
	require.NoError(t, err)
	var atRevoke string
	e.dbx.onRevoke = func() { atRevoke, _ = e.h.dbx.store.RefreshToken(context.Background()) }
	require.Contains(t, e.signIn(""), "Connected")
	require.NotEmpty(t, atRevoke, "a revoke was sent")
	assert.NotEqual(t, first, atRevoke, "the new sign-in was already saved when the old one was revoked")
}

// A reconnect that gets back the same refresh token revokes nothing (Security's SHOULD a on #14640): revoking it would end the new sign-in too.
func TestAReconnectWithTheSameTokenRevokesNothing(t *testing.T) {
	e := newDropboxEnv(t)
	e.dbx.sameRefresh = true
	require.Contains(t, e.signIn(""), "Connected")
	require.Contains(t, e.signIn(""), "Connected")
	assert.Equal(t, 0, e.dbx.revoked, "the same token is not revoked")
	assert.Equal(t, true, e.status()["connected"])
}

// A confirmed switch whose save fails leaves the old sign-in as it was: nothing is revoked before the new one is stored (QA's gap on #14643).
func TestAFailedSwitchSaveRevokesNothing(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	e.dbx.account = "dbid:BBB"
	require.Contains(t, e.signIn(""), "different Dropbox account")
	e.h.dbx.save = func(context.Context, string, string, string) error { return errors.New("disk full") }
	rec := e.call(http.MethodPost, "/api/dropbox/switch", true, nil)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, 0, e.dbx.revoked, "the old sign-in was not revoked")
	st := e.status()
	assert.Equal(t, true, st["connected"])
	assert.Equal(t, "dbid:AAA", st["account_id"], "the old sign-in is still the stored one")
}

// The error envelope the settings page reads (Security's MUST on #14653): open_on_127 is the code, the sentence with the address is the error.
func TestOpenOn127AnswersTheEnvelopeTheSettingsPageReads(t *testing.T) {
	e := newDropboxEnv(t)
	e.host = "localhost:8420"
	rec := e.call(http.MethodPost, "/api/dropbox/connect", true, nil)
	require.Equal(t, http.StatusConflict, rec.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "open_on_127", body["code"])
	assert.Equal(t, "Open Coral at http://127.0.0.1:8420 to connect Dropbox", body["error"])
}

// #15641 (the Operator, 2026-11-11): Coral ships no Dropbox app key. The only key is the one a person supplies (CORAL_DROPBOX_APP_KEY); with none, the status says so.
// (This replaces #15065's TestTheAppKeyABuildSetsIsTheOneDropboxUses, which pinned a key stamped by the release workflow.)
func TestNoDropboxAppKeyIsBuiltIn(t *testing.T) {
	t.Setenv("CORAL_DROPBOX_APP_KEY", "")
	dir := t.TempDir()
	db, err := storetest.Open(t, filepath.Join(dir, "c.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewCloudHandler(store.NewSessionStore(db), dir)
	h.SetDropbox(store.NewDropboxStore(db, store.NewRemoteServerStore(db, dir)), dir)
	assert.Equal(t, "", h.dbx.appKey(), "a build carries no key of its own")

	t.Setenv("CORAL_DROPBOX_APP_KEY", "zyxwvutsrqponml")
	assert.Equal(t, "zyxwvutsrqponml", h.dbx.appKey(), "the environment's key still works")
}

// #15641: a v2.0.64 install is connected to Dropbox with the key that build shipped; this build has none. The server starts, the backup does not run (and does not
// loop or call Dropbox), and Settings is told why: paused_no_key. Failing-first: the status had no such field.
func TestAConnectedInstallWithNoAppKeyIsPausedNotBroken(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	e.h.dbx.appKey = func() string { return "" } // this build: no key
	st := e.status()
	assert.Equal(t, true, st["connected"], "the stored sign-in is kept")
	assert.Equal(t, false, st["app_key_set"])
	assert.Equal(t, true, st["paused_no_key"], "Settings can say the backup is paused for want of a key")
	calls := e.dbx.revoked
	assert.False(t, (&DropboxBackup{d: e.h.dbx}).ready(context.Background()), "the backup does not run without a key")
	assert.Equal(t, calls, e.dbx.revoked, "and asks Dropbox nothing")

	e.h.dbx.appKey = func() string { return "abcdefghij12345" }
	assert.Equal(t, false, e.status()["paused_no_key"], "with a key (the environment's) it is not paused")
}

// #15641: Disconnect works with no key (it asks Dropbox nothing) and clears the stored sign-in, so a person who does not want to add a key can leave.
func TestDisconnectWithNoAppKeyClearsTheSignIn(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	e.h.dbx.appKey = func() string { return "" }
	rec := e.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, 0, e.dbx.revoked, "Dropbox was asked nothing")
	assert.Equal(t, false, e.status()["connected"])
}
