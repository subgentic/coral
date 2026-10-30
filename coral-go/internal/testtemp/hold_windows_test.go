//go:build windows

package testtemp

import (
	"os"
	"path/filepath"
	"testing"
)

// While the private world is up, nothing can delete its folders; once it is cleaned up, they are gone. What tries fails in its own log, and the folder keeps its files.
func TestPrivateFoldersCannotBeRemovedWhileTheWorldIsUp(t *testing.T) {
	root := t.TempDir()
	tmp := filepath.Join(root, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	release := hold(root, tmp)
	if err := os.WriteFile(filepath.Join(tmp, "f"), []byte("x"), 0o600); err != nil {
		t.Fatalf("a file can still be made in a held folder: %v", err)
	}
	if err := os.Remove(filepath.Join(tmp, "f")); err != nil {
		t.Fatalf("and removed: %v", err)
	}
	if err := os.RemoveAll(tmp); err == nil {
		t.Fatal("a held folder was removed")
	}
	if err := os.RemoveAll(root); err == nil {
		t.Fatal("the folder holding a held folder was removed")
	}
	if _, err := os.Stat(tmp); err != nil {
		t.Fatalf("the held folder is gone: %v", err)
	}
	release()
	if err := os.RemoveAll(tmp); err != nil {
		t.Fatalf("released, it can be removed: %v", err)
	}
}
