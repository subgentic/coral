package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// #11198: a paused board delivers nothing, and read and check say so. Before, read printed "No new messages." and check "0 unread" while the Stop hook counted the unread ones and handed them over
// at every turn end, for hours after a restart left the board paused.
func TestReadAndCheckSayWhenTheBoardIsPaused(t *testing.T) {
	isolateBoardEnv(t)
	saveState(&boardState{Project: "test-proj", JobTitle: "Dev"})
	paused := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/goals"):
			w.Write([]byte(`{"goals":[],"next_cursor":""}`))
		case strings.HasSuffix(r.URL.Path, "/messages/check"):
			if paused {
				w.Write([]byte(`{"unread":3,"paused":true}`))
			} else {
				w.Write([]byte(`{"unread":3}`))
			}
		default:
			if paused {
				w.Header().Set("X-Coral-Board-Paused", "true")
			}
			w.Write([]byte("[]"))
		}
	}))
	defer ts.Close()
	oldURL := serverURL
	serverURL = ts.URL
	defer func() { serverURL = oldURL }()
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	os.Args = []string{"coral-board", "read"}
	out := stdoutOf(t, cmdRead)
	if !strings.Contains(out, "This board is paused") || strings.Contains(out, "No new messages") {
		t.Errorf("a paused board's read says it is paused, not that nothing is new: %q", out)
	}
	os.Args = []string{"coral-board", "check"}
	out = stdoutOf(t, cmdCheck)
	if !strings.Contains(out, "3 unread message(s)") || !strings.Contains(out, "This board is paused") {
		t.Errorf("check gives the count and says the board is paused: %q", out)
	}
	os.Args = []string{"coral-board", "check", "--quiet"}
	if out = stdoutOf(t, cmdCheck); out != "3\n" {
		t.Errorf("--quiet is the number alone: %q", out)
	}

	paused = false
	os.Args = []string{"coral-board", "read"}
	out = stdoutOf(t, cmdRead)
	if !strings.Contains(out, "No new messages.") || strings.Contains(out, "paused") {
		t.Errorf("a board that is not paused reads as before: %q", out)
	}
}
