//go:build rig

package store

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A manual rig tool, not a test (#13079): registers SSH computers on a hub's TEMP data folder with a remote port the Set up flow cannot choose (it only ever uses 8420), so a throwaway hub can reach isolated Corals
// on other ports over ssh -W. Never run it against a real data folder: it is refused unless the folder is under the system temp dir or /sd2. Stop the hub first. Not built without -tags rig.
//
//	RIG_HUB_DATA_DIR=/tmp/rig-hub RIG_ROWS='id|label|ssh-target|port|instance-id|api-key;id2|...' go test -tags rig -run TestRigAddSSH -count=1 ./internal/store
func TestRigAddSSH(t *testing.T) {
	dir, rows := os.Getenv("RIG_HUB_DATA_DIR"), os.Getenv("RIG_ROWS")
	if dir == "" || rows == "" {
		t.Skip("RIG_HUB_DATA_DIR and RIG_ROWS name the hub's temp data folder and the rows to add")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if tmp := os.TempDir(); !strings.HasPrefix(abs, tmp+"/") && !strings.HasPrefix(abs, "/tmp/") && !strings.HasPrefix(abs, "/private/tmp/") && !strings.HasPrefix(abs, "/sd2/") {
		t.Fatalf("%s is not a temp folder: this tool only edits a throwaway hub's data", abs)
	}
	ctx := context.Background()
	db, err := OpenWithKey(ctx, filepath.Join(abs, "sessions.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	st := NewRemoteServerStore(db, abs)
	for _, row := range strings.Split(rows, ";") {
		f := strings.Split(strings.TrimSpace(row), "|")
		if len(f) != 6 {
			t.Fatalf("a row is id|label|ssh-target|port|instance-id|api-key, got %q", row)
		}
		port, err := strconv.Atoi(f[3])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.AddSSH(ctx, f[0], f[1], f[2], port, f[4], f[5]); err != nil {
			t.Fatalf("%s: %v", f[0], err)
		}
		t.Logf("added %s -> %s port %d", f[0], f[2], port)
	}
}
