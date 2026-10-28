package routes

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/subgentic/coral/internal/config"
)

// ensureScratchDir makes the scratch folder when a launch names exactly it, and nothing else (#10034).
func TestEnsureScratchDirMakesOnlyTheExactScratchPath(t *testing.T) {
	root := t.TempDir()
	h := &SessionsHandler{cfg: &config.Config{CoralRoot: root}}
	scratch := config.ScratchDir(root)

	for name, dir := range map[string]string{
		"empty":             "",
		"the root itself":   root,
		"a sibling":         filepath.Join(root, "coral-scratch2"),
		"a child":           filepath.Join(scratch, "sub"),
		"another folder":    filepath.Join(root, "work"),
		"a relative name":   "coral-scratch",
		"above the scratch": filepath.Dir(root),
		"a look-alike":      filepath.Join(root, "Coral-Scratch-x"),
		"outside the root":  filepath.Join(os.TempDir(), "coral-scratch-elsewhere-10034"),
	} {
		h.ensureScratchDir(dir)
		if _, err := os.Stat(scratch); err == nil {
			t.Fatalf("%s: %q made the scratch folder", name, dir)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("a refused path made something under the root: %v %v", entries, err)
	}
	if _, err := os.Stat(filepath.Join(os.TempDir(), "coral-scratch-elsewhere-10034")); err == nil {
		t.Fatal("a path outside the root was made")
	}

	h.ensureScratchDir(scratch)
	if info, err := os.Stat(scratch); err != nil || !info.IsDir() {
		t.Fatalf("the exact scratch path was not made: %v", err)
	}
	h.ensureScratchDir(scratch + string(filepath.Separator)) // the same folder spelled with a trailing slash
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Fatalf("expected only the scratch folder, got %v", entries)
	}
}

func TestEnsureScratchDirWithNoRootMakesNothing(t *testing.T) {
	h := &SessionsHandler{cfg: &config.Config{CoralRoot: ""}}
	dir := filepath.Join(t.TempDir(), "coral-scratch")
	h.ensureScratchDir(dir)
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("a launch with no configured root made a folder")
	}
}
