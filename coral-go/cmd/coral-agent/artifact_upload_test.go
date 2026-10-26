package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// #4004: a refused or failed upload returns an error and prints no coral:// link, so a caller
// that misses the exit code can't mistake a refusal for success (the bug that posted dead links).
func TestUploadArtifactRefusalIsAnError(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name       string
		status     int
		retryAfter string
		body       string
		wantInErr  []string
	}{
		{"429 with Retry-After and a reason", http.StatusTooManyRequests, "60",
			`{"error":"hourly upload limit reached","code":"artifact_quota","limit":"hourly"}`,
			[]string{"rate limited", "hourly upload limit reached", "Retry-After: 60"}},
		{"429 with no body", http.StatusTooManyRequests, "30", "",
			[]string{"rate limited", "Retry-After: 30"}},
		{"500 with a plain body", http.StatusInternalServerError, "", "something broke",
			[]string{"HTTP 500", "something broke"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			var out, errOut bytes.Buffer
			err := uploadArtifact(srv.URL, file, "note.txt", "text/plain", "sess-1", "", "", &out, &errOut)
			if err == nil {
				t.Fatalf("a %d answer must be an error, got nil (out=%q)", tc.status, out.String())
			}
			if out.Len() != 0 {
				t.Errorf("no coral:// link may be printed on a refusal, got stdout=%q", out.String())
			}
			if strings.Contains(out.String(), "coral://") {
				t.Errorf("stdout must not contain a coral:// link: %q", out.String())
			}
			for _, want := range tc.wantInErr {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q must contain %q", err.Error(), want)
				}
			}
		})
	}
}

// #4004 (b): a 2xx reply that carries no artifact id (a success-shaped refusal) is a failure too,
// so the exit code is the only thing a caller can get wrong. No coral:// link is printed.
func TestUploadArtifactTwoXXWithoutIdIsAFailure(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, body string }{
		{"200 with an error body", `{"error":"hourly upload limit reached"}`},
		{"201 with an empty object", `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			var out, errOut bytes.Buffer
			err := uploadArtifact(srv.URL, file, "note.txt", "text/plain", "sess-1", "", "", &out, &errOut)
			if err == nil {
				t.Fatalf("a 2xx with no artifact id must be an error, got nil (out=%q)", out.String())
			}
			if strings.Contains(out.String(), "coral://") || out.Len() != 0 {
				t.Errorf("no link may be printed, got stdout=%q", out.String())
			}
		})
	}
}

// A 2xx upload prints the server's reply (the coral:// link) to stdout and returns no error.
func TestUploadArtifactSuccessPrintsTheLink(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	const reply = `{"uri":"coral://artifacts/abc123","name":"note.txt"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Artifact-Name") != "note.txt" {
			t.Errorf("name header not forwarded: %q", r.Header.Get("X-Artifact-Name"))
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(reply))
	}))
	defer srv.Close()

	var out, errOut bytes.Buffer
	if err := uploadArtifact(srv.URL, file, "note.txt", "text/plain", "sess-1", "", "", &out, &errOut); err != nil {
		t.Fatalf("a 2xx upload must succeed: %v (stderr=%q)", err, errOut.String())
	}
	if !strings.Contains(out.String(), "coral://artifacts/abc123") {
		t.Errorf("the coral:// link must be printed to stdout, got %q", out.String())
	}
}

// #6357: --new-version-of is sent as X-Artifact-New-Version-Of, exactly as typed (the server accepts only a 64-hex digest link or a 32-hex series link and refuses anything else before any
// lookup); without it no such header goes. A refusal of a new version (the bytes are an older version) is an error and prints no link, like any refused upload.
func TestUploadArtifactSendsTheNewVersionHeaderAndAnOlderVersionIsAnError(t *testing.T) {
	file := filepath.Join(t.TempDir(), "plan.txt")
	if err := os.WriteFile(file, []byte("plan"), 0o600); err != nil {
		t.Fatal(err)
	}
	var seen []string
	refuse := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("X-Artifact-New-Version-Of"))
		if refuse {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"these bytes are version 1 of this series, and the newest is version 3: nothing was added","code":"same_as_older_version"}`))
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"uri":"coral://artifacts/` + strings.Repeat("ab", 32) + `","series_id":"` + strings.Repeat("cd", 16) + `","version":2,"versions":2}`))
	}))
	defer srv.Close()
	var out, errOut bytes.Buffer
	link := "coral://artifacts/series/" + strings.Repeat("cd", 16)
	if err := uploadArtifact(srv.URL, file, "plan.txt", "text/plain", "s1", link, "", &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if err := uploadArtifact(srv.URL, file, "plan.txt", "text/plain", "s1", "", "", &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 || seen[0] != link || seen[1] != "" {
		t.Fatalf("the header is sent as typed with the flag and not without it: %q", seen)
	}
	if !strings.Contains(out.String(), `"series_id"`) || !strings.Contains(out.String(), `"version":2`) {
		t.Errorf("the reply's series fields are printed: %q", out.String())
	}
	refuse = true
	out.Reset()
	err := uploadArtifact(srv.URL, file, "plan.txt", "text/plain", "s1", link, "", &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "version 1 of this series") || !strings.Contains(err.Error(), "HTTP 409") {
		t.Fatalf("an older version must be an error naming the version: %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("no link is printed for a refusal: %q", out.String())
	}
}

// #7739: --task N and --no-task go to the server as X-Artifact-Task (a number, or "none"); without either no such header goes. The task the reply says it linked is on stderr as "Linked to task #N",
// and stdout is still the reply alone, which a script parses.
func TestUploadArtifactSendsTheTaskHeaderAndSaysWhatItLinked(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("X-Artifact-Task"))
		task := r.Header.Get("X-Artifact-Task")
		if task == "none" {
			_, _ = w.Write([]byte(`{"uri":"coral://artifacts/abc123"}`))
			return
		}
		_, _ = w.Write([]byte(`{"uri":"coral://artifacts/abc123","task_id":7644}`))
	}))
	defer srv.Close()
	for _, task := range []string{"", "7644", "none"} {
		var out, errOut bytes.Buffer
		if err := uploadArtifact(srv.URL, file, "note.txt", "text/plain", "sess-1", "", task, &out, &errOut); err != nil {
			t.Fatalf("task %q: %v", task, err)
		}
		linked := strings.Contains(errOut.String(), "Linked to task #7644")
		if linked != (task != "none") {
			t.Errorf("task %q: stderr %q", task, errOut.String())
		}
		if strings.Contains(out.String(), "Linked to") || !strings.Contains(out.String(), "coral://artifacts/abc123") {
			t.Errorf("task %q: stdout must be the reply alone, got %q", task, out.String())
		}
	}
	if strings.Join(got, ",") != ",7644,none" {
		t.Errorf("the header goes only when asked for: %q", got)
	}
}

// #7739: the options of the command line: --no-task is a switch, --task needs a number, and the two together are a usage error that sends nothing.
func TestArtifactUploadTaskOptionsOnTheCommandLine(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var headers []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		headers = append(headers, r.Header.Get("X-Artifact-Task"))
		mu.Unlock()
		_, _ = w.Write([]byte(`{"uri":"coral://artifacts/abc123"}`))
	}))
	defer srv.Close()
	for _, bad := range [][]string{{"--task", "abc"}, {"--task", "0"}, {"--task", "5", "--no-task"}} {
		code, _, _ := runAgentWithToken(t, srv.URL, append([]string{"artifact", "upload", file}, bad...)...)
		if code != 2 {
			t.Errorf("%v: exit %d, want the usage error 2", bad, code)
		}
	}
	mu.Lock()
	initialHeaders := append([]string(nil), headers...)
	mu.Unlock()
	if len(initialHeaders) != 0 {
		t.Fatalf("a usage error sends nothing: %v", initialHeaders)
	}
	if code, _, e := runAgentWithToken(t, srv.URL, "artifact", "upload", file, "--no-task"); code != 0 {
		t.Fatalf("--no-task: exit %d %s", code, e)
	}
	if code, _, e := runAgentWithToken(t, srv.URL, "artifact", "upload", file, "--task", "7644"); code != 0 {
		t.Fatalf("--task: exit %d %s", code, e)
	}
	mu.Lock()
	gotHeaders := append([]string(nil), headers...)
	mu.Unlock()
	if strings.Join(gotHeaders, ",") != "none,7644" {
		t.Errorf("headers %q", gotHeaders)
	}
}

// #8583: --tag is repeatable and each word travels as a tag parameter of the upload; the server's reply (with the normalised tags) is printed as it came.
func TestUploadArtifactSendsEachTagAsAParameter(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query()["tag"]
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"uri":"coral://artifacts/` + strings.Repeat("a", 64) + `","tags":["for review","internal"]}`))
	}))
	defer srv.Close()
	var out, errOut bytes.Buffer
	if err := uploadArtifactTags(srv.URL, file, "note.txt", "text/plain", "sess-1", "", "", []string{"for review", "internal", "q4&x=1"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "for review|internal|q4&x=1" {
		t.Errorf("the server saw tags %q", got)
	}
	if !strings.Contains(out.String(), `"tags":["for review","internal"]`) {
		t.Errorf("the reply is printed as it came: %q", out.String())
	}
	got = nil
	if err := uploadArtifact(srv.URL, file, "note.txt", "text/plain", "sess-1", "", "", &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("no --tag: no tag parameter, saw %q", got)
	}
}

func TestSplitOptionsKeepsEveryValueOfARepeatedOption(t *testing.T) {
	opts, err := splitOptions([]string{"report.md", "--tag", "for review", "--tag=internal", "--name", "n", "-tag", "final"}, []string{"name", "tag"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(opts.All["tag"], "|") != "for review|internal|final" {
		t.Errorf("all the tags, in order: %q", opts.All["tag"])
	}
	if opts.Values["tag"] != "final" || opts.Values["name"] != "n" || len(opts.Positional) != 1 {
		t.Errorf("the others are as before: %+v", opts)
	}
}
