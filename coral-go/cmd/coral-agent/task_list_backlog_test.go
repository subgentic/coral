package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// #22067 (QA's SHOULD on #22048): coral-agent task list names a backlog task "backlog" and says how to claim it by number.
func TestAgentTaskListShowsBacklogAndHowToClaimIt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tasks":[
		  {"id":7,"status":"pending","priority":"medium","assigned_to":"Dev","title":"for later","parked_reason":"backlog"},
		  {"id":8,"status":"pending","priority":"medium","assigned_to":"Dev","title":"do now"},
		  {"id":9,"status":"pending","priority":"medium","assigned_to":"Dev","title":"parked till tomorrow","parked_reason":"backlog","parked_until":"2099-01-01T00:00:00Z"}]}`))
	}))
	defer srv.Close()
	old, oldURL := os.Stdout, serverURL
	serverURL = srv.URL
	t.Setenv("CORAL_SESSION_NAME", "claude-ba1e7db2-1c63-db8c-1540-862373255348")
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	cmdTaskList(false)
	w.Close()
	os.Stdout, serverURL = old, oldURL
	got := <-done
	line := func(id string) string {
		for _, l := range strings.Split(got, "\n") {
			if strings.HasPrefix(l, "#"+id) {
				return l
			}
		}
		return ""
	}
	if !strings.Contains(line("7"), "backlog") || strings.Contains(line("7"), "pending") {
		t.Fatalf("task 7 lists as backlog:\n%s", got)
	}
	if !strings.Contains(line("8"), "pending") {
		t.Fatalf("a plain task stays pending:\n%s", got)
	}
	if !strings.Contains(line("9"), "pending") {
		t.Fatalf("a park with an end is not the backlog:\n%s", got)
	}
	if !strings.Contains(got, "task claim N") {
		t.Fatalf("the claim-by-number hint is missing:\n%s", got)
	}
}
