package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// #8957: the review pool's CLI: submit-review's --areas and --reviewers, and coral-board reviewer set.

func TestSubmitReviewSendsAreasAndReviewersAndSaysItIsInThePool(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "worker")
	saveState(&boardState{Project: "pool", JobTitle: "Developer"})
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":42,"status":"review_pending","assigned_to":"lead","workflow":{"review_in_pool":true,"review_areas":["ui","go"],"reviewers_wanted":2}}`))
	}))
	defer server.Close()
	serverURL = server.URL
	before := os.Args
	defer func() { os.Args = before }()
	os.Args = []string{"coral-board", "task", "submit-review", "42", "--reason", "ready", "--areas", "ui, go,", "--reviewers", "2"}
	out := captureStdout(t, cmdTask)
	if got, _ := body["areas"].([]any); len(got) != 2 || got[0] != "ui" || got[1] != "go" {
		t.Fatalf("areas: %#v", body["areas"])
	}
	if body["reviewers"] != float64(2) {
		t.Fatalf("reviewers: %#v", body["reviewers"])
	}
	for _, want := range []string{"Task #42 is in the review pool", "areas: ui, go", "two reviewers", "your slot is free"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q misses %q", out, want)
		}
	}
	if strings.Contains(out, "is in review with lead") {
		t.Fatalf("a pooled review is not 'in review with' the orchestrator: %q", out)
	}
}

func TestSubmitReviewWithoutAreasSendsNoneAndKeepsTheOldLine(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "worker")
	saveState(&boardState{Project: "pool", JobTitle: "Developer"})
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":42,"status":"review_pending","assigned_to":"lead"}`))
	}))
	defer server.Close()
	serverURL = server.URL
	before := os.Args
	defer func() { os.Args = before }()
	os.Args = []string{"coral-board", "task", "submit-review", "42", "--reason", "ready"}
	out := captureStdout(t, cmdTask)
	if _, has := body["areas"]; has {
		t.Fatalf("no areas were given: %#v", body)
	}
	if _, has := body["reviewers"]; has {
		t.Fatalf("no reviewers were asked for: %#v", body)
	}
	if !strings.Contains(out, "Task #42 is in review with lead; your slot is free.") {
		t.Fatalf("the orchestrator line changed: %q", out)
	}
}

func TestReviewerSetSendsTheSettingAndPrintsIt(t *testing.T) {
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "Operator")
	saveState(&boardState{Project: "pool", JobTitle: "Operator"})
	var method, path string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.EscapedPath()
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"subscriber_id":"Security Reviewer","reviews_only":true,"review_areas":["go","security"]}`))
	}))
	defer server.Close()
	serverURL = server.URL
	before := os.Args
	defer func() { os.Args = before }()

	os.Args = []string{"coral-board", "reviewer", "set", "Security Reviewer", "--reviews-only", "--areas", "go, Security"}
	out := captureStdout(t, func() { cmdReviewer(os.Args[2:]) })
	if method != "PUT" || path != "/api/board/pool/subscribers/Security%20Reviewer/review-settings" {
		t.Fatalf("%s %s", method, path)
	}
	if body["reviews_only"] != true {
		t.Fatalf("body: %#v", body)
	}
	if got, _ := body["review_areas"].([]any); len(got) != 2 || got[0] != "go" || got[1] != "Security" {
		t.Fatalf("areas are sent as typed, the server normalises them: %#v", body["review_areas"])
	}
	if !strings.Contains(out, "Security Reviewer: reviews only (areas: go, security).") {
		t.Fatalf("output: %q", out)
	}

	// only what is asked for is sent; "none" clears the areas
	body = nil
	os.Args = []string{"coral-board", "reviewer", "set", "Security Reviewer", "--areas", "none"}
	captureStdout(t, func() { cmdReviewer(os.Args[2:]) })
	if _, has := body["reviews_only"]; has {
		t.Fatalf("the switch was not asked for: %#v", body)
	}
	if got, ok := body["review_areas"].([]any); !ok || len(got) != 0 {
		t.Fatalf("none is an empty list: %#v", body["review_areas"])
	}
	body = nil
	os.Args = []string{"coral-board", "reviewer", "set", "Security Reviewer", "--no-reviews-only"}
	captureStdout(t, func() { cmdReviewer(os.Args[2:]) })
	if body["reviews_only"] != false {
		t.Fatalf("off: %#v", body)
	}
	if _, has := body["review_areas"]; has {
		t.Fatalf("the areas were not asked for: %#v", body)
	}
}
