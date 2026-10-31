package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #11450: "settings set <key> <value>" is one PUT /api/settings with that one key as a string, says what was saved, says what the server refused (its status and words), and any other form is a usage error.
func TestSettingsSetPutsOneKeyAndSaysWhatHappened(t *testing.T) {
	isolateBoardEnv(t)
	var gotMethod, gotPath string
	var gotBody map[string]any
	status, reply := http.StatusOK, `{"ok":true}`
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = nil
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(status)
		w.Write([]byte(reply))
	}))
	defer ts.Close()
	oldURL := serverURL
	serverURL = ts.URL
	defer func() { serverURL = oldURL }()

	var out bytes.Buffer
	if err := runSettings([]string{"set", "chief_team", "chief"}, &out); err != nil {
		t.Fatal(err)
	}
	if gotMethod != "PUT" || gotPath != "/api/settings" || len(gotBody) != 1 || gotBody["chief_team"] != "chief" {
		t.Errorf("the call: %s %s %v", gotMethod, gotPath, gotBody)
	}
	if out.String() != "Saved chief_team.\n" {
		t.Errorf("output %q", out.String())
	}

	status, reply = http.StatusForbidden, `{"error":"forbidden_for_agent"}`
	err := runSettings([]string{"set", "chief_page", "true"}, &out)
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || !strings.Contains(err.Error(), "forbidden_for_agent") {
		t.Errorf("a refusal is said with its status and words: %v", err)
	}

	for _, bad := range [][]string{{}, {"set"}, {"set", "k"}, {"get", "k", "v"}, {"set", "k", "v", "x"}} {
		if err := runSettings(bad, &out); err == nil {
			t.Errorf("%v is a usage error", bad)
		} else if _, ok := err.(errLinkUsage); !ok {
			t.Errorf("%v: %T, want a usage error", bad, err)
		}
	}
}
