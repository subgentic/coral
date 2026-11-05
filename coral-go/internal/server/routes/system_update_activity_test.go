package routes

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13340 (Security's INFO on #13258): Coral Hub's owner having this computer check for an update, or relaunch into one, is a row of the Operator's Activity record, by the Hub user, as Send for review is. A refusal, the
// person here and Coral's own idle install write none.
type activityRows struct {
	mu   sync.Mutex
	rows []activityRow
	fail bool
}
type activityRow struct {
	meta                              board.ActivityMeta
	action, kind, item, version, team string
}

func (a *activityRows) record(_ context.Context, m board.ActivityMeta, action, kind, item, version, team string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rows = append(a.rows, activityRow{m, action, kind, item, version, team})
	if a.fail {
		return errors.New("cannot record")
	}
	return nil
}

func (a *activityRows) all() []activityRow {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]activityRow(nil), a.rows...)
}

func TestTheHubsUpdateCheckAndRelaunchAreRowsOfTheOperatorsRecordByTheHubUser(t *testing.T) {
	e := newRelaunchEnv(t)
	e.up.rec.Enabled, e.up.rec.Supported = true, true
	rec := &activityRows{}
	e.h.Activity = rec.record
	owner := hubHdr(ownerA)

	// a refused check writes nothing (the switch off, a stranger)
	e.settings[HubRelaunchSetting] = "false"
	code, _ := e.checkHub("", "", owner)
	require.Equal(t, http.StatusForbidden, code)
	e.settings[HubRelaunchSetting] = "true"
	code, _ = e.checkHub("", "", hubHdr("someone-else"))
	require.Equal(t, http.StatusForbidden, code)
	assert.Empty(t, rec.all(), "no row for a check that did not start")

	// the accepted check: one row, by the Hub user's opaque label, source hub, the update as the item
	code, _ = e.checkHub("", "", owner)
	require.Equal(t, http.StatusAccepted, code)
	require.Eventually(t, func() bool { return e.checksRun() == 1 }, 2*time.Second, 10*time.Millisecond)
	rows := rec.all()
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActHubUpdateCheck, rows[0].action)
	assert.Equal(t, "update", rows[0].kind)
	assert.Equal(t, "coral", rows[0].item)
	assert.Equal(t, "hub", rows[0].meta.Source)
	assert.Regexp(t, `^hub:`, rows[0].meta.Actor, "the Hub user's record label")
	assert.NotContains(t, rows[0].meta.Actor, ownerA, "the pseudonym itself is not written, only its label")
	code, _ = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusTooManyRequests, code)
	assert.Len(t, rec.all(), 1, "a second ask inside the minute is not a second row")

	// the relaunch the Hub started: a row with the staged version
	_, st := e.status(owner)
	rl := st["relaunch"].(map[string]any)
	code, out := e.post(ack(rl["ack"].(string)), owner)
	require.Equal(t, http.StatusAccepted, code, "%v", out)
	rows = rec.all()
	require.Len(t, rows, 2)
	assert.Equal(t, board.ActHubUpdateRelaunch, rows[1].action)
	assert.Equal(t, "1.4.131", rows[1].version, "the version it relaunched into")
	assert.Equal(t, "from 1.4.130", rows[1].meta.Note)
	assert.Equal(t, "hub", rows[1].meta.Source)

	// a row that cannot be written does not stop the update
	rec.fail = true
	e.now = e.now.Add(2 * time.Hour)
	e.h.checking.Store(false)
	code, _ = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusAccepted, code, "the record never blocks an update")
}

// The person at this computer is not Coral Hub: their own check and relaunch, and Coral's idle install, write no Hub row.
func TestOnlyACallThroughTheHubWritesAHubUpdateRow(t *testing.T) {
	e := newRelaunchEnv(t)
	rec := &activityRows{}
	e.h.Activity = rec.record
	e.h.hubActivity(context.Background(), localIdentity, board.ActHubUpdateCheck, "", "")
	e.h.hubActivity(context.Background(), callerIdentity{owner: true, pseudo: "auto"}, board.ActHubUpdateRelaunch, "1.4.131", "1.4.130")
	assert.Empty(t, rec.all())
	e.h.Activity = nil
	e.h.hubActivity(context.Background(), callerIdentity{owner: true, pseudo: ownerA}, board.ActHubUpdateCheck, "", "") // no hook: nothing, no panic
}

// Security's INFO a on #13340: the installed version in the note, and the version column, are only what the status reply would show (a plain x.y.z); anything else from the updater's record is left out.
func TestTheHubUpdateRowCarriesOnlyAPlainVersion(t *testing.T) {
	e := newRelaunchEnv(t)
	rec := &activityRows{}
	e.h.Activity = rec.record
	id := callerIdentity{owner: true, pseudo: ownerA}
	e.h.hubActivity(context.Background(), id, board.ActHubUpdateRelaunch, "1.4.131", "1.4.130")
	e.h.hubActivity(context.Background(), id, board.ActHubUpdateRelaunch, "1.4.131", "1.4.130-beta\x1b[31m; rm -rf /")
	e.h.hubActivity(context.Background(), id, board.ActHubUpdateRelaunch, "v9.9.9 http://evil.example/x", "1.4.130")
	rows := rec.all()
	require.Len(t, rows, 3)
	assert.Equal(t, "from 1.4.130", rows[0].meta.Note)
	assert.Equal(t, "1.4.131", rows[0].version)
	assert.Equal(t, "", rows[1].meta.Note, "an installed version that is not x.y.z is no note")
	assert.Equal(t, "1.4.131", rows[1].version)
	assert.Equal(t, "", rows[2].version, "a staged version that is not x.y.z is not written")
	assert.Equal(t, "", rows[2].meta.Note)
}

// #13370 (the #13340 review's SHOULDs): the two lines a test did not pin.
func hubUpdateCaller() callerIdentity { return callerIdentity{owner: true, pseudo: "hub-user-a"} }

// (a) the row is written with a context that outlives the request: the Hub user who closes the page at once must not lose the record of what they had the computer do.
func TestTheHubUpdateRowIsWrittenAfterTheClientLeavesNotWithTheRequestContext(t *testing.T) {
	var sawErr error
	called := false
	h := &UpdateRelaunchHandler{Activity: func(ctx context.Context, _ board.ActivityMeta, _, _, _, _, _ string) error {
		called = true
		sawErr = ctx.Err()
		return nil
	}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the client has gone
	h.hubActivity(ctx, hubUpdateCaller(), board.ActHubUpdateRelaunch, "1.2.3", "1.2.2")
	require.True(t, called, "the row was written")
	require.NoError(t, sawErr, "with a context the client leaving does not cancel")
}

// (b) the "from <installed>" note needs both versions: with the staged one missing, or the installed one, there is no note (and no half-sentence).
func TestTheHubUpdateRowsFromNoteNeedsBothTheInstalledAndTheStagedVersion(t *testing.T) {
	for _, c := range []struct{ name, installed, version, note string }{
		{"both", "1.2.2", "1.2.3", "from 1.2.2"},
		{"no staged version", "1.2.2", "", ""},
		{"no installed version", "", "1.2.3", ""},
		{"neither", "", "", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := &activityRows{}
			h := &UpdateRelaunchHandler{Activity: rec.record}
			h.hubActivity(context.Background(), hubUpdateCaller(), board.ActHubUpdateRelaunch, c.version, c.installed)
			rows := rec.all()
			require.Len(t, rows, 1)
			require.Equal(t, c.note, rows[0].meta.Note)
		})
	}
}
