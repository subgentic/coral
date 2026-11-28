package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #22160: a large prune reads its task and session lists a page at a time and gives the read connection back between pages, so a chat read gets one while the prune is mid-scan (coral-hub #286989).
func TestPruneDiffListsGiveTheReadConnectionBackBetweenPages(t *testing.T) {
	rig := newPruneRig(t)
	old := 20 * 24 * time.Hour
	var closed []int64
	for i := 0; i < 5; i++ {
		closed = append(closed, rig.task("completed", old, []byte("diff --git a/a b/a\n+x\n")))
	}
	rig.session("sess-a", "inactive", false, old, []byte("diff --git a/a b/a\n+a\n"))
	rig.session("sess-b", "inactive", false, old, []byte("diff --git a/a b/a\n+b\n"))
	rig.session("sess-c", "inactive", false, old, []byte("diff --git a/a b/a\n+c\n"))

	rig.h.db.Reader().SetMaxOpenConns(1) // one connection: a prune holding it would starve any other read
	oldPage, oldHook := pruneReadPage, pruneAfterPage
	pruneReadPage = 2
	pages := 0
	pruneAfterPage = func() {
		pages++
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		var n int
		assert.NoError(t, rig.h.db.Reader().GetContext(ctx, &n, "SELECT 1"), "a chat read must get the connection between the prune's pages")
		assert.Zero(t, rig.h.db.Reader().Stats().InUse)
	}
	t.Cleanup(func() { pruneReadPage, pruneAfterPage = oldPage, oldHook })

	got, err := rig.h.closedDiffs(context.Background(), pruneOptions{Now: rig.now, OlderThan: 7 * 24 * time.Hour})
	require.NoError(t, err)
	assert.Len(t, got, len(closed)+3, "paging loses no row")
	assert.GreaterOrEqual(t, pages, 5, "5 tasks and 3 sessions at 2 a page: several pages")
}
