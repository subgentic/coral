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
	"time"
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

// A repo that ships .coral-attachments (or the .gitignore in it) as a link must not make a download write outside the folder (#17407, Security on #17332): only a real folder and a real file are used,
// otherwise the download goes to the system temp folder as before.
func TestADownloadNeverFollowsALinkedAttachmentsFolder(t *testing.T) {
	data := []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("y", 64))
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:])
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(data)
	}))
	defer server.Close()
	t.Setenv("CORAL_SESSION_NAME", "claude-abc")
	for _, name := range []string{"folder", "gitignore"} {
		t.Run(name, func(t *testing.T) {
			work, outside := t.TempDir(), t.TempDir()
			t.Chdir(work)
			if name == "folder" {
				if err := os.Symlink(outside, filepath.Join(work, ".coral-attachments")); err != nil {
					t.Skip("no links here:", err)
				}
			} else {
				if err := os.Mkdir(filepath.Join(work, ".coral-attachments"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(outside, "target"), filepath.Join(work, ".coral-attachments", ".gitignore")); err != nil {
					t.Skip("no links here:", err)
				}
			}
			got, err := downloadArtifact(server.URL, "coral://artifacts/"+id, "")
			if err != nil {
				t.Fatal(err)
			}
			defer os.Remove(got)
			if entries, _ := os.ReadDir(outside); len(entries) != 0 {
				t.Fatalf("something was written through the link: %v", entries)
			}
			if _, err := os.Stat(filepath.Join(outside, "target")); err == nil {
				t.Fatal("the .gitignore link was written through")
			}
			if wd, _ := filepath.EvalSymlinks(work); strings.HasPrefix(got, wd) {
				t.Fatalf("the download went into the folder through a link: %s", got)
			}
		})
	}
}

// #17407 (INFO): downloads are not kept for ever: a coral-artifact-* file older than a week is removed by the next download, a newer one and any other file stay.
func TestAnAttachmentOlderThanAWeekIsSweptAndOthersStay(t *testing.T) {
	dir := t.TempDir()
	old, fresh, other := filepath.Join(dir, "coral-artifact-1.png"), filepath.Join(dir, "coral-artifact-2.png"), filepath.Join(dir, "notes.txt")
	for _, f := range []string{old, fresh, other} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	long := time.Now().Add(-8 * 24 * time.Hour)
	for _, f := range []string{old, other} {
		if err := os.Chtimes(f, long, long); err != nil {
			t.Fatal(err)
		}
	}
	sweepAttachments(dir, time.Now())
	if _, err := os.Stat(old); err == nil {
		t.Error("the old attachment is still there")
	}
	for _, f := range []string{fresh, other} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s was removed: %v", filepath.Base(f), err)
		}
	}
}
