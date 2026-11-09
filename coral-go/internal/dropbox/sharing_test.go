package dropbox

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeSharing answers the sharing endpoints the way Dropbox does, recording each call's endpoint and argument.
type fakeSharing struct {
	calls  []string
	args   []map[string]any
	answer map[string]func(w http.ResponseWriter)
}

func (f *fakeSharing) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ep := strings.TrimPrefix(r.URL.Path, "/2/")
		f.calls = append(f.calls, ep)
		var arg map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &arg)
		f.args = append(f.args, arg)
		if a, ok := f.answer[ep]; ok {
			a(w)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func jsonAnswer(code int, body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = io.WriteString(w, body)
	}
}

const goodLink = "https://www.dropbox.com/scl/fi/abc123/release-plan.md?rlkey=xyz&dl=0"

func TestValidLinkAcceptsOnlyDropboxSharedLinks(t *testing.T) {
	for _, ok := range []string{goodLink, "https://www.dropbox.com/s/abc/file.md?dl=0"} {
		if !ValidLink(ok) {
			t.Errorf("refused %q", ok)
		}
	}
	for _, bad := range []string{
		"http://www.dropbox.com/scl/fi/a/b",           // not https
		"https://dropbox.com/scl/fi/a/b",              // not the exact host
		"https://www.dropbox.com.evil.example/scl/fi", // a look-alike host
		"https://user@www.dropbox.com/scl/fi/a",       // a user part
		"https://www.dropbox.com:8443/scl/fi/a",       // a port
		"https://www.dropbox.com/home",                // not a shared-link path
		"javascript:alert(1)",
		"https://www.dropbox.com/scl/fi/a\"><script>",
		"https://www.dropbox.com/scl/fi/a#frag",
		"",
	} {
		if ValidLink(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestCreateLinkSendsViewOnlySettingsAndChecksTheAnswer(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"sharing/create_shared_link_with_settings": jsonAnswer(200, `{"url":"`+goodLink+`","expires":"2026-12-09T10:00:00Z","link_permissions":{"effective_audience":{".tag":"team"}}}`),
	}}
	c := newTestClient(t, f.server(t))
	exp := time.Date(2026, 12, 9, 10, 0, 0, 0, time.UTC)
	l, err := c.CreateLink(context.Background(), "tok", "/Shared from Coral/Team A/release-plan.md", AudienceTeam, exp)
	if err != nil {
		t.Fatal(err)
	}
	if l.URL != goodLink || l.Audience != AudienceTeam || !l.Expires.Equal(exp) {
		t.Fatalf("got %+v", l)
	}
	s := f.args[0]["settings"].(map[string]any)
	if s["audience"].(map[string]any)[".tag"] != "team" || s["access"].(map[string]any)[".tag"] != "viewer" || s["expires"] != "2026-12-09T10:00:00Z" {
		t.Fatalf("settings %v", s)
	}

	// No expiry: none is sent.
	f.args = nil
	f.answer["sharing/create_shared_link_with_settings"] = jsonAnswer(200, `{"url":"`+goodLink+`","link_permissions":{"effective_audience":{".tag":"public"}}}`)
	l, err = c.CreateLink(context.Background(), "tok", "/p", AudiencePublic, time.Time{})
	if err != nil || l.Audience != AudiencePublic || !l.Expires.IsZero() {
		t.Fatalf("%+v %v", l, err)
	}
	if _, has := f.args[0]["settings"].(map[string]any)["expires"]; has {
		t.Fatal("an expiry was sent")
	}
}

func TestCreateLinkRefusesALinkCoralWillNotShow(t *testing.T) {
	for name, body := range map[string]string{
		"another host":     `{"url":"https://evil.example/scl/fi/a","link_permissions":{"effective_audience":{".tag":"public"}}}`,
		"an odd audience":  `{"url":"` + goodLink + `","link_permissions":{"effective_audience":{".tag":"no_one"}}}`,
		"a broken expires": `{"url":"` + goodLink + `","expires":"soon","link_permissions":{"effective_audience":{".tag":"public"}}}`,
	} {
		f := &fakeSharing{answer: map[string]func(http.ResponseWriter){"sharing/create_shared_link_with_settings": jsonAnswer(200, body)}}
		c := newTestClient(t, f.server(t))
		if _, err := c.CreateLink(context.Background(), "tok", "/p", AudiencePublic, time.Time{}); !errors.Is(err, ErrBadLink) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSharingRefusalsAreNamed(t *testing.T) {
	for _, tc := range []struct {
		code int
		body string
		want error
	}{
		{401, `{"error_summary":"missing_scope/..","error":{".tag":"missing_scope","required_scope":"sharing.write"}}`, ErrMissingScope},
		{409, `{"error_summary":"shared_link_already_exists/metadata/..","error":{".tag":"shared_link_already_exists"}}`, ErrLinkExists},
		{409, `{"error_summary":"settings_error/not_authorized/..","error":{".tag":"settings_error"}}`, ErrLinkSettings},
	} {
		f := &fakeSharing{answer: map[string]func(http.ResponseWriter){"sharing/create_shared_link_with_settings": jsonAnswer(tc.code, tc.body)}}
		c := newTestClient(t, f.server(t))
		_, err := c.CreateLink(context.Background(), "tok", "/p", AudiencePublic, time.Time{})
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.body, err, tc.want)
		}
		if err != nil && strings.Contains(err.Error(), "required_scope") {
			t.Errorf("the body leaked into the error: %v", err)
		}
	}
}

func TestSharedLinksKeepsOnlyValidLinks(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"sharing/list_shared_links": jsonAnswer(200, `{"links":[{"url":"`+goodLink+`","link_permissions":{"effective_audience":{".tag":"public"}}},{"url":"https://evil.example/x","link_permissions":{"effective_audience":{".tag":"public"}}}]}`),
	}}
	c := newTestClient(t, f.server(t))
	links, err := c.SharedLinks(context.Background(), "tok", "/p")
	if err != nil || len(links) != 1 || links[0].URL != goodLink {
		t.Fatalf("%+v %v", links, err)
	}
	if f.args[0]["direct_only"] != true {
		t.Fatal("not direct_only")
	}
}

func TestRevokeLinkChecksTheLinkAndTakesAGoneLinkAsRevoked(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"sharing/revoke_shared_link": jsonAnswer(409, `{"error_summary":"shared_link_not_found/.."}`),
	}}
	c := newTestClient(t, f.server(t))
	if err := c.RevokeLink(context.Background(), "tok", "https://evil.example/scl/x"); !errors.Is(err, ErrBadLink) {
		t.Fatalf("a bad link was sent: %v", err)
	}
	if len(f.calls) != 0 {
		t.Fatal("a call was made for a bad link")
	}
	if err := c.RevokeLink(context.Background(), "tok", goodLink); err != nil {
		t.Fatalf("a gone link: %v", err)
	}
	f.answer["sharing/revoke_shared_link"] = jsonAnswer(500, `{}`)
	if err := c.RevokeLink(context.Background(), "tok", goodLink); err == nil {
		t.Fatal("a failed revoke was taken as done")
	}
}

func TestAddFileMembersIsViewOnlyAndFailsOnARefusedMember(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"sharing/add_file_member": jsonAnswer(200, `[{"member":{".tag":"email","email":"a@example.com"},"result":{".tag":"success"}}]`),
	}}
	c := newTestClient(t, f.server(t))
	if err := c.AddFileMembers(context.Background(), "tok", "id:abc", []string{"a@example.com"}); err != nil {
		t.Fatal(err)
	}
	a := f.args[0]
	if a["file"] != "id:abc" || a["access_level"].(map[string]any)[".tag"] != "viewer" {
		t.Fatalf("arg %v", a)
	}
	if err := c.AddFileMembers(context.Background(), "tok", "/a path", []string{"a@example.com"}); err == nil {
		t.Fatal("a path, not an id, was accepted")
	}
	many := make([]string, MaxMembers+1)
	if err := c.AddFileMembers(context.Background(), "tok", "id:abc", many); err == nil {
		t.Fatal("more than MaxMembers accepted")
	}
	f.answer["sharing/add_file_member"] = jsonAnswer(200, `[{"result":{".tag":"invalid_member"}}]`)
	if err := c.AddFileMembers(context.Background(), "tok", "id:abc", []string{"x"}); err == nil || !strings.Contains(err.Error(), "invalid_member") {
		t.Fatalf("a refused member: %v", err)
	}
}

func TestCopyNeverAutorenamesAndReturnsTheCopy(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"files/copy_v2": jsonAnswer(200, `{"metadata":{".tag":"file","id":"id:new","rev":"0123abc","content_hash":"h1"}}`),
	}}
	c := newTestClient(t, f.server(t))
	m, err := c.Copy(context.Background(), "tok", "/v1/abc/doc/v1-1234.md", "/Shared from Coral/Team A/x.md")
	if err != nil || m.FileID != "id:new" || m.Rev != "0123abc" || m.ContentHash != "h1" {
		t.Fatalf("%+v %v", m, err)
	}
	if f.args[0]["autorename"] != false {
		t.Fatal("autorename")
	}
}

func TestCurrentAccountSaysBasicAndTeam(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"users/get_current_account": jsonAnswer(200, `{"account_id":"dbid:A","account_type":{".tag":"business"},"team":{"name":"Acme\u202e Corp"}}`),
	}}
	c := newTestClient(t, f.server(t))
	a, err := c.CurrentAccount(context.Background(), "tok")
	if err != nil || a.Basic || a.TeamName != "Acme Corp" {
		t.Fatalf("%+v %v", a, err)
	}
	f.answer["users/get_current_account"] = jsonAnswer(200, `{"account_id":"dbid:B","account_type":{".tag":"basic"}}`)
	a, err = c.CurrentAccount(context.Background(), "tok")
	if err != nil || !a.Basic || a.TeamName != "" {
		t.Fatalf("%+v %v", a, err)
	}
}

func TestUnshareFileTakesANotSharedFileAsDone(t *testing.T) {
	f := &fakeSharing{answer: map[string]func(http.ResponseWriter){
		"sharing/unshare_file": jsonAnswer(409, `{"error_summary":"access_error/invalid_file/.."}`),
	}}
	c := newTestClient(t, f.server(t))
	if err := c.UnshareFile(context.Background(), "tok", "id:abc"); err != nil {
		t.Fatal(err)
	}
	f.answer["sharing/unshare_file"] = jsonAnswer(409, `{"error_summary":"access_error/no_permission/.."}`)
	if err := c.UnshareFile(context.Background(), "tok", "id:abc"); err == nil || !strings.Contains(err.Error(), "access_error/no_permission") {
		t.Fatalf("a refusal was taken as done: %v", err)
	}
}
