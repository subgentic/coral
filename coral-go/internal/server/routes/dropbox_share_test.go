package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
)

// Share via Dropbox (#14944), against the fake Dropbox. Each test names the mutant it fails against.

// sharing answers the sharing endpoints (the fake's mutex is held).
func (f *fakeDropbox) sharing(w http.ResponseWriter, r *http.Request) {
	var a map[string]any
	_ = json.NewDecoder(r.Body).Decode(&a)
	refuse := func(code int, summary string) {
		w.WriteHeader(code)
		fmt.Fprintf(w, `{"error_summary":%q}`, summary)
	}
	if f.noScope && r.URL.Path != "/2/files/copy_v2" && r.URL.Path != "/2/users/get_current_account" {
		refuse(http.StatusUnauthorized, "missing_scope/..")
		return
	}
	if f.links == nil {
		f.links, f.members = map[string][]fakeLink{}, map[string][]string{}
	}
	str := func(k string) string { s, _ := a[k].(string); return s }
	switch r.URL.Path {
	case "/2/users/get_current_account":
		out := map[string]any{"account_id": f.account, "account_type": map[string]string{".tag": map[bool]string{true: "basic", false: "pro"}[f.basic]}}
		if f.team != "" {
			out["team"] = map[string]string{"name": f.team}
		}
		json.NewEncoder(w).Encode(out)
	case "/2/files/copy_v2":
		f.copies++
		from, to := str("from_path"), str("to_path")
		b, ok := f.files[from]
		if !ok {
			refuse(http.StatusConflict, "from_lookup/not_found/")
			return
		}
		if _, there := f.files[to]; there {
			refuse(http.StatusConflict, "to/conflict/file/")
			return
		}
		f.files[to] = append([]byte(nil), b...)
		hash := dropbox.ContentHash(b)
		if f.copyBadHash {
			hash = dropbox.ContentHash([]byte("other bytes"))
		}
		json.NewEncoder(w).Encode(map[string]any{"metadata": map[string]any{".tag": "file", "id": "id:" + to, "rev": "r1", "content_hash": hash}})
	case "/2/sharing/add_file_member":
		if f.membersFail {
			json.NewEncoder(w).Encode([]any{map[string]any{"result": map[string]string{".tag": "invalid_member"}}})
			return
		}
		file := str("file")
		ms, _ := a["members"].([]any)
		var out []any
		for _, m := range ms {
			e, _ := m.(map[string]any)["email"].(string)
			f.members[file] = append(f.members[file], e)
			out = append(out, map[string]any{"result": map[string]string{".tag": "success"}})
		}
		json.NewEncoder(w).Encode(out)
	case "/2/sharing/create_shared_link_with_settings":
		p := str("path")
		if _, ok := f.files[p]; !ok {
			refuse(http.StatusConflict, "path/not_found/")
			return
		}
		if len(f.links[p]) > 0 {
			refuse(http.StatusConflict, "shared_link_already_exists/..")
			return
		}
		set, _ := a["settings"].(map[string]any)
		aud, _ := set["audience"].(map[string]any)[".tag"].(string)
		exp, _ := set["expires"].(string)
		if exp != "" && f.basic {
			refuse(http.StatusConflict, "settings_error/not_authorized/")
			return
		}
		l := fakeLink{url: fmt.Sprintf("https://www.dropbox.com/scl/fi/%d/x?rlkey=k", len(f.links)+1), aud: aud, expires: exp}
		f.links[p] = append(f.links[p], l)
		json.NewEncoder(w).Encode(f.linkJSON(l))
	case "/2/sharing/list_shared_links":
		if f.checkFail != "" && str("path") == "" {
			refuse(http.StatusConflict, f.checkFail)
			return
		}
		var out []any
		for _, l := range f.links[str("path")] {
			out = append(out, f.linkJSON(l))
		}
		json.NewEncoder(w).Encode(map[string]any{"links": out})
	case "/2/sharing/revoke_shared_link":
		if f.revokeFail {
			refuse(http.StatusInternalServerError, "internal_error/")
			return
		}
		u := str("url")
		for p, ls := range f.links {
			for i, l := range ls {
				if l.url == u {
					f.links[p] = append(ls[:i], ls[i+1:]...)
					w.Write([]byte("null"))
					return
				}
			}
		}
		refuse(http.StatusConflict, "shared_link_not_found/")
	case "/2/sharing/unshare_file":
		delete(f.members, str("file"))
		w.Write([]byte("null"))
	}
}

func (f *fakeDropbox) linkJSON(l fakeLink) map[string]any {
	m := map[string]any{"url": l.url, "link_permissions": map[string]any{"effective_audience": map[string]string{".tag": l.aud}}}
	if l.expires != "" {
		m["expires"] = l.expires
	}
	return m
}

// shareCall sends a share route through a chi router as the Operator's dashboard (callerKind as the identity observer stamps it), or as kind.
func (be *backupEnv) shareCall(method, url, body, kind string) (int, map[string]any) {
	be.t.Helper()
	r := chi.NewRouter()
	r.Get("/api/dropbox/share/{digest}", be.h.DropboxShareInfo)
	r.Post("/api/dropbox/share/{digest}", be.h.DropboxShare)
	r.Post("/api/dropbox/share/stop/{id}", be.h.DropboxStopShare)
	r.Get("/api/dropbox/shares", be.h.DropboxShares)
	r.Post("/api/dropbox/shares/stop-all", be.h.DropboxStopAllShares)
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	dashboardRequest(req)
	req.Host = be.host
	if kind != "" {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	return rec.Code, m
}

func (be *backupEnv) share(digest, body string) (int, map[string]any) {
	return be.shareCall(http.MethodPost, "/api/dropbox/share/"+digest, body, callerDashCookie)
}

func newDropboxShareEnv(t *testing.T) (*backupEnv, string) {
	t.Helper()
	be := newBackupEnv(t)
	be.b.retainPoll, be.b.retainWait = time.Millisecond, 50*time.Millisecond
	d := be.put("release-plan.md", "text/markdown", "# Release plan\n")
	be.pass()
	return be, d
}

func (be *backupEnv) sharedPaths() []string {
	be.dbx.mu.Lock()
	defer be.dbx.mu.Unlock()
	var out []string
	for p := range be.dbx.files {
		if strings.HasPrefix(p, shareRoot+"/") {
			out = append(out, p)
		}
	}
	return out
}

// Mutants: the share is made by upload when the backup has the bytes; the copy is not checked; the link is stored; the audit holds a name.
func TestAPublicLinkCopiesTheBackupsFileAndChecksIt(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	code, out := be.share(d, `{"name":"release-plan.md","audience":"public","expire":true,"confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	link, _ := out["link"].(string)
	assert.True(t, dropbox.ValidLink(link), link)
	assert.NotEmpty(t, out["expires_at"], "30 days on a plan that allows it")
	assert.Equal(t, 1, be.dbx.copies, "copied inside Dropbox from the backup, nothing uploaded again")
	paths := be.sharedPaths()
	require.Len(t, paths, 1)
	assert.True(t, strings.HasPrefix(paths[0], shareRoot+"/"), paths[0])
	assert.True(t, strings.HasSuffix(paths[0], "/release-plan.md"), paths[0])

	var cnt int
	require.NoError(t, be.db.GetContext(context.Background(), &cnt, "SELECT COUNT(*) FROM dropbox_shares WHERE state = 'live'"))
	assert.Equal(t, 1, cnt)
	raw, _ := json.Marshal(dumpTable(t, be, "dropbox_shares"))
	assert.NotContains(t, string(raw), "https://", "the link is never stored")
	a, _ := be.h.dbx.store.Audits(context.Background(), 1)
	require.Len(t, a, 1)
	assert.Equal(t, store.DropboxAudit{At: a[0].At, Kind: "share", Who: "operator", Reason: "public"}, a[0], "a word and counts only")

	// The dialog reads it again: the live link is shown from Dropbox.
	code, info := be.shareCall(http.MethodGet, "/api/dropbox/share/"+d, "", callerDashCookie)
	require.Equal(t, http.StatusOK, code, "%v", info)
	shares, _ := info["shares"].([]any)
	require.Len(t, shares, 1)
	assert.Equal(t, link, shares[0].(map[string]any)["link"])
}

func dumpTable(t *testing.T, be *backupEnv, table string) []map[string]any {
	rows, err := be.db.QueryxContext(context.Background(), "SELECT * FROM "+table)
	require.NoError(t, err)
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		m := map[string]any{}
		require.NoError(t, rows.MapScan(m))
		for k, v := range m {
			if b, ok := v.([]byte); ok {
				m[k] = string(b)
			}
		}
		out = append(out, m)
	}
	return out
}

// Mutant: a copy whose hash is not the bytes' is shared or kept (condition 5).
func TestACopyThatIsNotTheFileIsDeletedAndNothingShared(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	be.dbx.copyBadHash = true
	code, out := be.share(d, `{"name":"release-plan.md","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusBadGateway, code)
	assert.Equal(t, "copy_mismatch", out["code"])
	assert.Empty(t, be.sharedPaths(), "the copy was deleted")
	assert.Empty(t, be.dbx.links, "no link was made")
	n, _ := be.b.outbox.SharedCount(context.Background())
	assert.Zero(t, n)
}

// Mutants: people get a link instead of membership; an address with a display name or a list passes; the people are stored.
func TestSpecificPeopleAreAddedByEmailViewOnly(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	for _, bad := range []string{`[]`, `["Ana <ana@example.com>"]`, `["ana@example.com, sam@example.com"]`, `["not an address"]`} {
		code, out := be.share(d, `{"name":"x.md","audience":"people","emails":`+bad+`,"confirm":true}`)
		assert.Equal(t, http.StatusBadRequest, code, "%s %v", bad, out)
	}
	assert.Empty(t, be.sharedPaths())
	code, out := be.share(d, `{"name":"x.md","audience":"people","emails":["Ana@Example.com","sam@example.com","ana@example.com"],"confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Nil(t, out["link"], "people get no link")
	assert.EqualValues(t, 2, out["people"])
	paths := be.sharedPaths()
	require.Len(t, paths, 1)
	assert.Equal(t, []string{"ana@example.com", "sam@example.com"}, be.dbx.members["id:"+paths[0]])
	assert.Empty(t, be.dbx.links)
	raw, _ := json.Marshal(dumpTable(t, be, "dropbox_shares"))
	assert.NotContains(t, string(raw), "example.com", "who it was shared with is never stored")
}

// Mutants: a share without confirm acts; the team choice works off a team; an agent, the Hub, an API key or a plain local script shares.
func TestSharingIsTheOperatorsPressOnThisComputer(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	code, _ := be.share(d, `{"name":"x.md","audience":"public"}`)
	assert.Equal(t, http.StatusBadRequest, code, "the press is required")
	code, out := be.share(d, `{"name":"x.md","audience":"team","confirm":true}`)
	assert.Equal(t, http.StatusBadRequest, code, "no team: %v", out)
	for _, kind := range []string{"", callerHub, callerHubOwner, callerAgentToken, callerAPIKey, callerLocalOther} {
		code, _ = be.shareCall(http.MethodPost, "/api/dropbox/share/"+d, `{"name":"x.md","audience":"public","confirm":true}`, kind)
		assert.Equal(t, http.StatusForbidden, code, "caller %q", kind)
		code, _ = be.shareCall(http.MethodGet, "/api/dropbox/shares", "", kind)
		assert.Equal(t, http.StatusForbidden, code, "caller %q lists", kind)
	}
	assert.Empty(t, be.sharedPaths())

	be.dbx.team = "Acme"
	code, out = be.share(d, `{"name":"x.md","audience":"team","confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "team", be.dbx.links[be.sharedPaths()[0]][0].aud)
}

// Mutants: a private file is shared; a flagged file gets a link without its second confirm.
func TestAPrivateFileIsNotSharedAndAFlaggedOneNeedsItsConfirm(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	be.private[d] = true
	code, _ := be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusForbidden, code)
	code, _ = be.shareCall(http.MethodGet, "/api/dropbox/share/"+d, "", callerDashCookie)
	assert.Equal(t, http.StatusForbidden, code)
	be.private[d] = false
	be.privErr = fmt.Errorf("unreadable")
	code, _ = be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusForbidden, code, "an unreadable mark fails closed")
	be.privErr = nil

	be.b.secret = func([]byte) bool { return true }
	code, out := be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "secret_confirm", out["code"])
	assert.Empty(t, be.sharedPaths())
	code, _ = be.share(d, `{"name":"x.md","audience":"public","confirm":true,"secret_ok":true}`)
	assert.Equal(t, http.StatusOK, code)
}

// Mutants: a taken name is overwritten or refused rather than suffixed; the name is not cleaned.
func TestNamesAreCleanedAndATakenOneGetsASuffix(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	for i := 0; i < 2; i++ {
		code, out := be.share(d, `{"name":"../..\\Release\u202e plan","audience":"public","confirm":true}`)
		require.Equal(t, http.StatusOK, code, "%v", out)
	}
	paths := be.sharedPaths()
	require.Len(t, paths, 2)
	names := map[string]bool{}
	for _, p := range paths {
		names[p[strings.LastIndex(p, "/")+1:]] = true
		assert.Equal(t, 3, strings.Count(p, "/"), "one folder under the root: %q", p)
	}
	assert.Equal(t, map[string]bool{"-..-Release plan.md": true, "-..-Release plan (2).md": true}, names)

	assert.Equal(t, "_con.txt", cleanShareName("con", ".txt"))
	assert.Equal(t, "", cleanShareName("...", ".md"))
	assert.Equal(t, "a.md", cleanShareName(".a", ".md"))
	assert.LessOrEqual(t, len(cleanShareName(strings.Repeat("é", 200), ".md")), shareNameMax)
}

// Condition 8. Mutants: the copy is deleted before the link is revoked; a failed revoke deletes the copy or drops the row.
func TestStopSharingRevokesFirstAndKeepsTheCopyWhenARevokeFails(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	code, out := be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	id := fmt.Sprint(out["id"])

	be.dbx.revokeFail = true
	code, out = be.shareCall(http.MethodPost, "/api/dropbox/share/stop/"+id, `{}`, callerDashCookie)
	assert.Equal(t, http.StatusBadGateway, code, "%v", out)
	assert.Equal(t, "still_shared", out["code"])
	assert.Len(t, be.sharedPaths(), 1, "the copy stays while its link may still work")
	n, _ := be.b.outbox.SharedCount(context.Background())
	assert.Equal(t, 1, n, "and the row stays, stopping")

	be.dbx.revokeFail = false
	code, out = be.shareCall(http.MethodPost, "/api/dropbox/share/stop/"+id, `{}`, callerDashCookie)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, be.sharedPaths())
	assert.Empty(t, be.dbx.links[shareRoot+"/release-plan.md"])
	n, _ = be.b.outbox.SharedCount(context.Background())
	assert.Zero(t, n)
}

// Mutants: Stop all needs no confirm; a share made with people keeps them after a stop.
func TestStopAllRemovesPeopleAndLinks(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	_, _ = be.share(d, `{"name":"a.md","audience":"people","emails":["ana@example.com"],"confirm":true}`)
	_, _ = be.share(d, `{"name":"b.md","audience":"public","confirm":true}`)
	require.Len(t, be.sharedPaths(), 2)
	code, _ := be.shareCall(http.MethodPost, "/api/dropbox/shares/stop-all", `{}`, callerDashCookie)
	assert.Equal(t, http.StatusBadRequest, code)
	code, out := be.shareCall(http.MethodPost, "/api/dropbox/shares/stop-all", `{"confirm":true}`, callerDashCookie)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 2, out["stopped"])
	assert.Empty(t, be.sharedPaths())
	assert.Empty(t, be.dbx.members)
}

// Mutants: a failure after the copy leaves it in Dropbox; an older sign-in is not told to sign in again.
func TestAFailureAfterTheCopyUndoesItAndAnOlderSignInIsAskedAgain(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	be.dbx.membersFail = true
	code, out := be.share(d, `{"name":"x.md","audience":"people","emails":["ana@example.com"],"confirm":true}`)
	assert.Equal(t, http.StatusBadGateway, code, "%v", out)
	assert.Empty(t, be.sharedPaths(), "the copy is undone")
	be.dbx.membersFail = false

	be.dbx.noScope = true
	copies := be.dbx.copies
	code, out = be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "sign_in_again", out["code"])
	assert.Equal(t, copies, be.dbx.copies, "nothing is copied before the sign-in is known to allow sharing")
	assert.Empty(t, be.sharedPaths())

	// A copy left by an earlier sign-in is still deleted by Stop sharing with one that lacks the scopes (deleting it ends its links).
	be.dbx.noScope = false
	code, out = be.share(d, `{"name":"y.md","audience":"public","confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	be.dbx.noScope = true
	code, out = be.shareCall(http.MethodPost, "/api/dropbox/share/stop/"+fmt.Sprint(out["id"]), `{}`, callerDashCookie)
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, be.sharedPaths())
}

// Mutants: a basic account gets an expiry it cannot have (Dropbox refuses) instead of none; the cleanup leaves a half-made share's link live.
func TestABasicAccountGetsNoExpiryAndTheCleanupUndoesAHalfMadeShare(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	be.dbx.basic = true
	code, out := be.share(d, `{"name":"x.md","audience":"public","expire":true,"confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Nil(t, out["expires_at"])
	assert.Contains(t, out["expiry"], "not available on this Dropbox plan", "asked for, not available: said (QA's INFO 6)")

	// A crash after the link: the row is still preparing, the link is not stored. The cleanup finds it in Dropbox and revokes it.
	ctx := context.Background()
	_, err := be.db.ExecContext(ctx, "UPDATE dropbox_shares SET state = 'preparing', created_at = ?", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339))
	require.NoError(t, err)
	be.b.CleanShares(ctx)
	assert.Empty(t, be.sharedPaths())
	for _, ls := range be.dbx.links {
		assert.Empty(t, ls)
	}
	n, _ := be.b.outbox.SharedCount(ctx)
	assert.Zero(t, n)
}

// Security's SHOULD on 8c44ed595. Mutant: the cleanup takes any file at a never-copied share's path as its copy and deletes it.
func TestTheCleanupLeavesAnotherFileAtANeverCopiedSharesPath(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	ctx := context.Background()
	src, err := be.b.shareSourceOf(d)
	require.NoError(t, err)
	p := shareRoot + "/Coral/mine.md"
	_, err = be.b.outbox.ReserveShare(ctx, store.DropboxShare{Path: p, Digest: d, Kind: store.DropboxShareArtifact, Audience: store.DropboxSharePublic,
		AccountID: "dbid:AAA", Hash: dropbox.ContentHash(src.data)}, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	be.dbx.mu.Lock()
	be.dbx.files[p] = []byte("the person's own file\n")
	be.dbx.mu.Unlock()
	be.b.CleanShares(ctx)
	assert.Equal(t, []string{p}, be.sharedPaths(), "another file at that name is left alone")
	n, _ := be.b.outbox.SharedCount(ctx)
	assert.Zero(t, n, "the row is dropped")

	// The same bytes at the path (a crash after the copy, before it was recorded): taken as the copy and deleted.
	_, err = be.b.outbox.ReserveShare(ctx, store.DropboxShare{Path: p + "2", Digest: d, Kind: store.DropboxShareArtifact, Audience: store.DropboxSharePublic,
		AccountID: "dbid:AAA", Hash: dropbox.ContentHash(src.data)}, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	be.dbx.mu.Lock()
	be.dbx.files[p+"2"] = src.data
	be.dbx.mu.Unlock()
	be.b.CleanShares(ctx)
	assert.Equal(t, []string{p}, be.sharedPaths(), "the unrecorded copy is deleted")
}

// Condition 9. Mutants: Disconnect, Switch or Rekey goes ahead while files are shared; the 409 does not name the count; leave_shared keeps rows
// for an account that is gone; a refused Switch loses the waiting switch.
func TestDisconnectSwitchAndRekeySayWhatIsStillShared(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	code, out := be.share(d, `{"name":"a.md","audience":"public","confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = be.share(d, `{"name":"b.md","audience":"people","emails":["ana@example.com"],"confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	shared := func() int { n, _ := be.b.outbox.SharedCount(context.Background()); return n }

	// Rekey: refused while shared, with the count; with leave_shared it goes on to its own checks (the key here is usable: rekey_not_needed).
	rekey := func(body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/cloud/rekey", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		dashboardRequest(req)
		req.Host = be.host
		rec := httptest.NewRecorder()
		be.h.Rekey(rec, req)
		var m map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &m)
		return rec.Code, m
	}
	code, out = rekey(`{"confirm":true}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "still_shared", out["code"])
	assert.EqualValues(t, 2, out["count"])
	assert.Contains(t, out["error"], "2 files are still shared")
	code, out = rekey(`{"confirm":true,"leave_shared":true}`)
	assert.Equal(t, "rekey_not_needed", out["code"], "the guard let it through: %d %v", code, out)

	// Switch: refused while shared, and the waiting switch is kept for the confirm again.
	be.dbx.account = "dbid:BBB"
	require.Contains(t, be.signIn(""), "different Dropbox account")
	be.body = `{}`
	rec := be.call(http.MethodPost, "/api/dropbox/switch", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "still_shared")
	assert.NotNil(t, be.status()["switch_pending"], "the switch still waits")
	assert.Equal(t, 2, shared())

	// Disconnect: refused while shared; with leave_shared it disconnects and forgets the rows (the copies stay in Dropbox).
	be.body = `{}`
	rec = be.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Equal(t, true, be.status()["connected"])
	be.body = `{"leave_shared":true}`
	rec = be.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Zero(t, shared())
	assert.Len(t, be.sharedPaths(), 2, "left shared in the person's Dropbox")
}

// Mutant: Stop all then Disconnect still asks (the guard counts stopped shares).
func TestAfterStopAllDisconnectNeedsNoConfirm(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	_, _ = be.share(d, `{"name":"a.md","audience":"public","confirm":true}`)
	code, _ := be.shareCall(http.MethodPost, "/api/dropbox/shares/stop-all", `{"confirm":true}`, callerDashCookie)
	require.Equal(t, http.StatusOK, code)
	be.body = `{}`
	rec := be.call(http.MethodPost, "/api/dropbox/disconnect", true, nil)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

// The Operator's walk (#198059): a refused sharing check says Dropbox's tag (it said only "Could not reach Dropbox"), and the sign-in-again answer
// names the app permissions. Mutant: the old sentence without the cause.
func TestARefusedSharingCheckSaysWhy(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	be.dbx.checkFail = "path/malformed_path/"
	code, out := be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	assert.Equal(t, http.StatusBadGateway, code)
	assert.Contains(t, out["error"], "path/malformed_path", "the cause is said")
	assert.Empty(t, be.sharedPaths())
	be.dbx.checkFail = ""
	be.dbx.noScope = true
	_, out = be.share(d, `{"name":"x.md","audience":"public","confirm":true}`)
	assert.Contains(t, out["error"], "sharing.write and sharing.read")
}
