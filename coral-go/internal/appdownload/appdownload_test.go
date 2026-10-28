package appdownload

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSafeName(t *testing.T) {
	cases := map[string]string{
		"report.md":              "report.md",
		"../../etc/passwd":       "passwd",
		`C:\Users\x\a.txt`:       "a.txt",
		"a:b*c?d.txt":            "abcd.txt",
		"  ..hidden":             "hidden",
		"trailing. . ":           "trailing",
		"":                       "download",
		"///":                    "download",
		"NUL.txt":                "_NUL.txt",
		"com1":                   "_com1",
		"x\u202egnp.exe":         "xgnp.exe",
		"tab\tand\x00nul.txt":    "tabandnul.txt",
		strings.Repeat("a", 300): strings.Repeat("a", 100),
	}
	for in, want := range cases {
		if got := SafeName(in); got != want {
			t.Errorf("SafeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSaveWritesAndNeverReplaces(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString([]byte("hello"))
	first, err := Save(dir, "note.txt", b64)
	if err != nil || filepath.Base(first) != "note.txt" {
		t.Fatalf("first save: %q %v", first, err)
	}
	if err := os.WriteFile(first, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	second, err := Save(dir, "note.txt", b64)
	if err != nil || filepath.Base(second) != "note (1).txt" {
		t.Fatalf("second save: %q %v", second, err)
	}
	if got, _ := os.ReadFile(first); string(got) != "mine" {
		t.Fatalf("the first file was replaced: %q", got)
	}
	if got, _ := os.ReadFile(second); string(got) != "hello" {
		t.Fatalf("second content %q", got)
	}
	third, err := Save(dir, "note.txt", b64)
	if err != nil || filepath.Base(third) != "note (2).txt" {
		t.Fatalf("third save: %q %v", third, err)
	}
}

func TestSaveStaysInTheFolder(t *testing.T) {
	dir := t.TempDir()
	path, err := Save(dir, "../../escape.txt", base64.StdEncoding.EncodeToString([]byte("x")))
	if err != nil || filepath.Dir(path) != dir {
		t.Fatalf("a name with path parts left the folder: %q %v", path, err)
	}
}

func TestSaveRefusesBadContent(t *testing.T) {
	dir := t.TempDir()
	if _, err := Save(dir, "a.txt", "***not base64***"); err == nil {
		t.Fatal("invalid base64 was accepted")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("a refused save left files: %v", entries)
	}
	if _, err := Save(dir, "a.txt", strings.Repeat("A", MaxBytes*4/3+100)); err == nil {
		t.Fatal("a file over the cap was accepted")
	}
}
