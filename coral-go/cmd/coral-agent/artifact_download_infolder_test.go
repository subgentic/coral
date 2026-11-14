package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Coral agent's download with no --output lands inside the folder it works in, so a chat image never makes the agent ask to read a file outside it (#17332, walk 63 F1).
func TestAnAgentsDownloadLandsInsideItsOwnFolder(t *testing.T) {
	data := []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("x", 64))
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:])
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(data)
	}))
	defer server.Close()
	work := t.TempDir()
	t.Chdir(work)
	t.Setenv("CORAL_SESSION_NAME", "claude-abc")
	got, err := downloadArtifact(server.URL, "coral://artifacts/"+id, "")
	if err != nil {
		t.Fatal(err)
	}
	wd, _ := filepath.EvalSymlinks(work)
	gd, _ := filepath.EvalSymlinks(filepath.Dir(got))
	if !strings.HasPrefix(gd, wd+string(filepath.Separator)) {
		t.Fatalf("the download is outside the agent's folder %s: %s", wd, got)
	}
	if filepath.Ext(got) != ".png" {
		t.Fatalf("no media extension: %s", got)
	}
	if ig, err := os.ReadFile(filepath.Join(filepath.Dir(got), ".gitignore")); err != nil || !strings.Contains(string(ig), "*") {
		t.Fatalf("the attachments folder must ignore itself so a commit never picks it up: %v %q", err, ig)
	}
	// outside a Coral agent session the file is a temp file, as before
	t.Setenv("CORAL_SESSION_NAME", "")
	other, err := downloadArtifact(server.URL, "coral://artifacts/"+id, "")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(other)
	if strings.HasPrefix(filepath.Dir(other), work) {
		t.Fatalf("a download outside an agent session went into the working folder: %s", other)
	}
}
