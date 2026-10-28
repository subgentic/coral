package license

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #10004: eula_accepted is sent only after the acceptance is on disk, never before, and from one place only (where the marker is written), so no path can announce an acceptance it did not record.
func TestEULAAcceptedIsTrackedOnlyAfterTheMarkerIsWritten(t *testing.T) {
	src, err := os.ReadFile("eula.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	write := strings.Index(body, "os.WriteFile(marker,")
	track := strings.Index(body, "tracking.TrackEULAAccepted(source)")
	if write < 0 || track < 0 {
		t.Fatalf("the marker write (%d) and the event call (%d) must both be in eula.go", write, track)
	}
	assert.Greater(t, track, write, "the event follows the write")
	// ... and only on its success: the line between them returns the write's error.
	assert.Contains(t, body[write:track], "return err", "a marker that could not be written announces nothing")

	var sites []string
	root := filepath.Join("..", "..")
	if err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || n == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") || strings.Contains(p, filepath.Join("internal", "tracking")+string(filepath.Separator)) {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if strings.Contains(string(b), "TrackEULAAccepted(") {
			sites = append(sites, filepath.ToSlash(p))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, []string{"../../internal/license/eula.go"}, sites, "one call site: where the marker is written")
}
