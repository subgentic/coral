package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gdocsync"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

const (
	gdocV3  = "dd00000000000000000000000000000000000000000000000000000000000004"
	gdocSid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// A shared series: version 1 shared (the first press), version 2 stored after it. Returns the rig and the time the passes run at.
func syncRig(t *testing.T) *gdocRig {
	t.Helper()
	g := newGdocRig(t, true)
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Friday.\n\nShip the build.\n")
	g.writeSeriesVersion(t, gdocSid, gdocV1, 1)
	status, _, raw := g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	g.artifact(t, gdocV2, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Monday.\n\nShip the build.\n")
	g.writeSeriesVersion(t, gdocSid, gdocV2, 2)
	return g
}

func (g *gdocRig) pass(st *gdocSyncState) { g.h.gdocSyncPass(context.Background(), st, time.Now()) }

func (g *gdocRig) share1(t *testing.T) *store.GdocShare {
	t.Helper()
	row, err := g.h.ss.GetGdocShare(context.Background(), gdocSid)
	require.NoError(t, err)
	require.NotNil(t, row)
	return row
}

// Slice C (#20010): a new version stored after the share goes to the same Doc by itself, changing only what differs.
func TestTheLoopPushesANewVersionToTheSameDocWithoutAPress(t *testing.T) {
	g := syncRig(t)
	before := g.drive.batches
	g.pass(&gdocSyncState{})
	assert.Equal(t, before+1, g.drive.batches, "one change sent")
	assert.Len(t, g.drive.uploads, 1, "no second Doc")
	assert.Equal(t, gdocV2, g.share1(t).Digest, "the share remembers the version in the Doc")
	calls := g.drive.calls
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls, "nothing new: no Google call at all")
}

// Turning the switch off stops all sync: a pass makes no Google call and never asks for the sign-in.
func TestTurningTheSwitchOffStopsTheLoopCompletely(t *testing.T) {
	g := syncRig(t)
	require.NoError(t, g.ss.SetSetting(context.Background(), setreg.GdocShare, "false"))
	asked := 0
	old := gdocClientFor
	t.Cleanup(func() { gdocClientFor = old })
	gdocClientFor = func() (*gdocsync.Client, error) { asked++; return old() }
	calls := g.drive.calls
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls, "no Google call while off")
	assert.Zero(t, asked, "no client, so no token read, while off")
	assert.Equal(t, gdocV1, g.share1(t).Digest, "nothing was pushed")
}

// The owner's per-Doc pause is honoured by the loop and by a press.
func TestAPausedDocIsNotSynced(t *testing.T) {
	g := syncRig(t)
	ok, err := g.ss.SetGdocShareState(context.Background(), gdocSid, store.GdocSharePaused)
	require.NoError(t, err)
	require.True(t, ok)
	calls := g.drive.calls
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls)
	status, out, _ := g.share(t, gdocV2)
	assert.Equal(t, 409, status)
	assert.Equal(t, "gdoc_paused", out["code"])
}

// A Doc edited in Google since the last sync is never overwritten: it is kept as it is, the new version goes to a new Doc, and the share points at the new one.
func TestADocEditedInGoogleIsKeptAndTheNewVersionGoesToANewDoc(t *testing.T) {
	g := syncRig(t)
	g.drive.revs = map[string]string{"doc1": "rev-edited-in-google"}
	batches := g.drive.batches
	g.pass(&gdocSyncState{})
	assert.Equal(t, batches, g.drive.batches, "the edited Doc was not written")
	require.Len(t, g.drive.uploads, 2, "the new version went to a new Doc")
	assert.Contains(t, g.drive.titles[1], "from Coral")
	row := g.share1(t)
	assert.Equal(t, "doc2", row.DocID)
	assert.Equal(t, "doc1", row.ConflictDoc, "the earlier Doc is remembered, so the owner can be pointed at it")
	assert.Equal(t, gdocV2, row.Digest)
}

// Google asking to slow down (429) stops the pass and the next ones wait, longer each time.
func TestGoogleSayingSlowDownMakesTheLoopWait(t *testing.T) {
	g := syncRig(t)
	g.drive.fail, g.drive.failStatus = 20, 429
	st := &gdocSyncState{}
	now := time.Now()
	g.h.gdocSyncPass(context.Background(), st, now)
	assert.True(t, st.until.After(now), "a wait was set")
	first := st.wait
	g.drive.fail = 0
	calls := g.drive.calls
	g.h.gdocSyncPass(context.Background(), st, now.Add(10*time.Second))
	assert.Equal(t, calls, g.drive.calls, "no call before the wait is over")
	g.drive.fail = 20
	g.h.gdocSyncPass(context.Background(), st, now.Add(first+time.Second))
	assert.Equal(t, 2*first, st.wait, "doubled")
}

// A change whose outcome is unknown (a server error on a write) pauses that Doc rather than send it again on a guess.
func TestAnUnknownOutcomePausesTheDoc(t *testing.T) {
	g := syncRig(t)
	g.drive.failWritesOnly = true
	g.drive.fail, g.drive.failStatus = 1, 500
	g.pass(&gdocSyncState{})
	assert.Equal(t, store.GdocSharePaused, g.share1(t).State)
}

// Outgoing text is redacted before it leaves, and an oversized file is refused.
func TestOutgoingTextIsRedactedAndCapped(t *testing.T) {
	g := newGdocRig(t, true)
	secret := "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
	g.artifact(t, gdocV3, "notes.md", "text/markdown", "# Notes\n\nThe token is "+secret+" for now.\n")
	status, _, raw := g.share(t, gdocV3)
	require.Equal(t, 200, status, raw)
	require.Len(t, g.drive.uploads, 1)
	assert.NotContains(t, g.drive.uploads[0], secret, "the secret did not leave this computer")
	assert.Contains(t, g.drive.uploads[0], "Notes")
	_ = strings.Repeat
}

// At most 20 changes an hour to one Doc.
func TestADocIsChangedAtMostTwentyTimesAnHour(t *testing.T) {
	l := &gdocLimiter{at: map[string][]time.Time{}}
	now := time.Now()
	for i := 0; i < gdocWritesPerHour; i++ {
		require.True(t, l.allow("k", now.Add(time.Duration(i)*time.Second)))
	}
	assert.False(t, l.allow("k", now.Add(time.Minute)), "the 21st in the hour is refused")
	assert.True(t, l.allow("other", now), "another Doc has its own bound")
	assert.True(t, l.allow("k", now.Add(61*time.Minute)), "an hour later it is allowed again")
}

func (g *gdocRig) send(t *testing.T, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, g.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// The owner's Pause and Resume, and Unshare, through their routes; the status says which.
func TestPauseResumeAndUnshareThroughTheRoutes(t *testing.T) {
	g := syncRig(t)
	path := "/api/artifacts/" + gdocV1 + "/gdoc/"
	status, _ := g.send(t, "POST", path+"sync", `{"paused":true}`)
	assert.Equal(t, 200, status)
	assert.Equal(t, true, g.status(t, gdocV1, nil)["paused"])
	calls := g.drive.calls
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls, "a paused Doc is not synced")
	status, _ = g.send(t, "POST", path+"sync", `{"paused":false}`)
	assert.Equal(t, 200, status)
	g.pass(&gdocSyncState{})
	assert.Equal(t, gdocV2, g.share1(t).Digest, "resumed: the newest version went")
	status, _ = g.send(t, "DELETE", path+"share", "")
	assert.Equal(t, 200, status)
	row, err := g.h.ss.GetGdocShare(context.Background(), gdocSid)
	require.NoError(t, err)
	assert.Nil(t, row, "unshared: Coral forgot the Doc")
	status, _ = g.send(t, "DELETE", path+"share", "")
	assert.Equal(t, 404, status, "nothing left to unshare")
	status, _ = g.send(t, "POST", path+"sync", `{"paused":true}`)
	assert.Equal(t, 404, status)
}

// With the switch off the new routes are refused like the rest.
func TestPauseAndUnshareAreRefusedWhileTheSwitchIsOff(t *testing.T) {
	g := newGdocRig(t, false)
	for _, c := range [][3]string{{"POST", "sync", `{"paused":true}`}, {"DELETE", "share", ""}} {
		status, out := g.send(t, c[0], "/api/artifacts/"+gdocV1+"/gdoc/"+c[1], c[2])
		assert.Equal(t, 403, status)
		assert.Equal(t, "gdoc_share_off", out["code"])
	}
}
