package protectedpath

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRefusalNamesTheSourceTreeAndTheRealCoralFolder(t *testing.T) {
	wd, _ := os.Getwd()
	if r := Refusal(filepath.Join(wd, "ct")); !strings.Contains(r, "source tree") {
		t.Errorf("source tree: %q", r)
	}
	for _, d := range Dirs() {
		if r := Refusal(filepath.Join(d, "ct")); !strings.Contains(r, "~/.coral") {
			t.Errorf("inside ~/.coral: %q", r)
		}
		if r := Refusal(filepath.Dir(d)); !strings.Contains(r, "~/.coral") {
			t.Errorf("around ~/.coral: %q", r)
		}
	}
	if r := Refusal(filepath.Join(t.TempDir(), "ct")); r != "" {
		t.Errorf("an ordinary folder: %q", r)
	}
}

func TestRefusalSaysWhenTheSourceTreeIsNotKnown(t *testing.T) {
	if r := refusal(filepath.Join(t.TempDir(), "ct"), struct {
		Dir   string
		Found bool
	}{}); !strings.Contains(r, "no go.mod") {
		t.Errorf("no go.mod: %q", r)
	}
}
