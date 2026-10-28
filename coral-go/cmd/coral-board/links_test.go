package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #9893: link and unlink send both ways with files on unless told otherwise, say what happened in words, and a usage mistake is a usage error; links prints what the route answered.
func TestLinkUnlinkAndLinksTalkToTheLinksRoute(t *testing.T) {
	isolateBoardEnv(t)
	var gotMethod, gotPath string
	var gotBody map[string]any
	status := http.StatusOK
	reply := `{"team":{"board":"alpha","label":"alpha","cross_team_id":"x-aaaaaaaaaaaaaaaa","files":true},` +
		`"may_message_this_team":[{"board":"beta","label":"beta","cross_team_id":"x-bbbbbbbbbbbbbbbb","files":true}],` +
		`"this_team_may_message":[{"board":"beta","label":"beta","cross_team_id":"x-bbbbbbbbbbbbbbbb","files":false}],"through_coral_hub":2,"enforced":false}`
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = nil
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(reply))
	}))
	defer ts.Close()
	oldURL := serverURL
	serverURL = ts.URL
	defer func() { serverURL = oldURL }()

	var out bytes.Buffer
	if err := runLink(false, []string{"alpha", "beta"}, &out); err != nil {
		t.Fatal(err)
	}
	if gotMethod != "POST" || gotPath != "/api/board/alpha/cross-team-links" || gotBody["with"] != "beta" || gotBody["both"] != true || gotBody["files"] != true {
		t.Errorf("the default link: %s %s %v", gotMethod, gotPath, gotBody)
	}
	if !strings.Contains(out.String(), "Linked alpha and beta: each may message the other (files on)") || !strings.Contains(out.String(), "not required yet") {
		t.Errorf("output %q", out.String())
	}

	out.Reset()
	if err := runLink(false, []string{"alpha", "beta", "--one-way", "--no-files"}, &out); err != nil {
		t.Fatal(err)
	}
	if gotBody["both"] != false || gotBody["files"] != false {
		t.Errorf("one way, no files: %v", gotBody)
	}
	if !strings.Contains(out.String(), "alpha may now message beta (one way, files off)") {
		t.Errorf("output %q", out.String())
	}

	out.Reset()
	if err := runLink(true, []string{"alpha", "beta"}, &out); err != nil {
		t.Fatal(err)
	}
	if gotMethod != "DELETE" || gotBody["both"] != true || gotBody["files"] != nil {
		t.Errorf("unlink: %s %v", gotMethod, gotBody)
	}
	if !strings.Contains(out.String(), "Unlinked alpha and beta") {
		t.Errorf("output %q", out.String())
	}

	for name, c := range map[string]struct {
		unlink bool
		args   []string
	}{
		"one team":           {false, []string{"alpha"}},
		"three":              {false, []string{"alpha", "beta", "gamma"}},
		"no files on unlink": {true, []string{"alpha", "beta", "--no-files"}},
	} {
		err := runLink(c.unlink, c.args, &out)
		var usage errLinkUsage
		if err == nil || !errors.As(err, &usage) {
			t.Errorf("%s: want a usage error, got %v", name, err)
		}
	}

	status, reply = http.StatusForbidden, `{"error":"only the Operator can read or change who may message a board"}`
	if err := runLink(false, []string{"alpha", "beta"}, &out); err == nil || !strings.Contains(err.Error(), "Operator") {
		t.Errorf("a refusal is an error that says why: %v", err)
	}

	status, reply = http.StatusOK, `{"team":{"board":"alpha","label":"alpha"},"may_message_this_team":[{"board":"beta","label":"beta","files":true}],"this_team_may_message":[{"board":"gamma","label":"gamma","files":false}],"through_coral_hub":2,"enforced":true}`
	out.Reset()
	if err := runLinks("alpha", &out); err != nil {
		t.Fatal(err)
	}
	listed := out.String()
	for _, want := range []string{"alpha", "may message this team: beta (files on)", "may be messaged by this team: gamma (files off)", "2 more through Coral Hub", "a team that is not linked is refused"} {
		if !strings.Contains(listed, want) {
			t.Errorf("links output lacks %q:\n%s", want, listed)
		}
	}
}
