package frontend

import (
	"io/fs"
	"strings"
	"testing"
)

// #10268: the session feed's handler hands each row of the open agent to the Files list's follower (a reply that ends, a count that moves), straight after it sets the count.
func TestTheFeedHandsRowsToTheFilesFollower(t *testing.T) {
	src, err := fs.ReadFile(Static, "static/websocket.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	i := strings.Index(body, "updateChangedFileCount(s.changed_file_count || 0);")
	if i < 0 || !strings.Contains(body[i:min(i+200, len(body))], "followChangedFiles(s);") {
		t.Fatal("websocket.js does not call followChangedFiles(s) right after updateChangedFileCount")
	}
}
