package branches

import (
	"testing"
	"time"
)

// A tab that asks for a folder with no picture yet starts a Branches pass now (Kicks), instead of waiting up to two minutes for the git poller's next pass (coral-hub's UI review:
// the first read took about 90 s). A kick is sent at most once per kickGap, one waiting kick is enough, and a folder that already has a picture sends none.
func TestAskingForAnUnreadFolderKicksAPassAtMostOncePerGap(t *testing.T) {
	c := New()
	now := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	dir := t.TempDir()
	kicked := func() bool {
		select {
		case <-c.Kicks():
			return true
		default:
			return false
		}
	}
	if _, _, ok := c.For(dir); ok {
		t.Fatal("an empty collector found a picture")
	}
	if !kicked() {
		t.Fatal("the first ask for an unread folder sent no kick")
	}
	c.For(dir)
	if kicked() {
		t.Error("a second ask within kickGap sent another kick")
	}
	now = now.Add(kickGap)
	c.For(dir)
	c.For(dir)
	if !kicked() {
		t.Error("an ask after kickGap sent no kick")
	}
	if kicked() {
		t.Error("two asks after kickGap sent two kicks")
	}

	// a folder that has a picture: no kick
	now = now.Add(time.Hour)
	c.mu.Lock()
	c.repos["k"] = &Repo{Worktrees: []Worktree{{path: canonical(dir)}}, At: now}
	c.mu.Unlock()
	if _, _, ok := c.For(dir); !ok {
		t.Fatal("the folder's picture was not found")
	}
	if kicked() {
		t.Error("a folder that already has a picture sent a kick")
	}
}
