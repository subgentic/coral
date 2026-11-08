package testrig

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/verify"
)

// paddedList is the rig's list of releases with n more releases after them, each carrying a note of noteBytes: GitHub's real list is that heavy (the notes of 30 releases weighed 1.05 MiB in
// November 2026, over the limit the check used to have).
func paddedList(t *testing.T, base []byte, n, noteBytes int) []byte {
	t.Helper()
	var list []map[string]any
	require.NoError(t, json.Unmarshal(base, &list))
	for i := 0; i < n; i++ {
		list = append(list, map[string]any{"tag_name": fmt.Sprintf("v1.3.%d", i), "draft": false, "prerelease": true, "assets": []any{}, "body": strings.Repeat("n", noteBytes)})
	}
	out, err := json.Marshal(list)
	require.NoError(t, err)
	return out
}

// The list of releases the check reads is over 1 MiB, as GitHub's real one became (30 releases with their notes): the check still reads it and stages the promotion in it. Before, the list was refused
// for its size and the check failed as a network failure, every time, so an installed Coral never updated again.
func TestAReleaseListOverOneMiBIsStillRead(t *testing.T) {
	r := newAPIRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	r.gh.ListBody = paddedList(t, r.gh.listJSON(), 29, 40000)
	require.Greater(t, len(r.gh.ListBody), 1<<20, "the list is over the old limit")
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	assert.Equal(t, "1.4.131", res.Version)
}

// A list that cannot be used (larger than any list can be, or not a list) is not "the network": it is its own kind, with the wait of a refusal (an hour, doubling to a day), not minutes.
func TestAListThatCannotBeReadIsItsOwnKindNotTheNetwork(t *testing.T) {
	for name, body := range map[string][]byte{
		"larger than the limit": bytes.Repeat([]byte(" "), 8<<20+10),
		"not a list":            []byte(`{"message":"API rate limit exceeded"}`),
	} {
		t.Run(name, func(t *testing.T) {
			r := newAPIRig(t)
			r.publish(Spec{Version: "1.4.131", Sequence: 7})
			r.gh.ListBody = body
			res := r.check()
			assert.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
			assert.Equal(t, "manifest", res.FailedStage)
			st, err := verify.LoadState(r.cfg.DataDir + "/" + stage.UpdatesDir)
			require.NoError(t, err)
			require.NotNil(t, st.Stage)
			assert.Equal(t, stage.KindList, st.Stage.ErrorKind, "not the network's kind")
			next, err := time.Parse(time.RFC3339, res.NextAttempt)
			require.NoError(t, err)
			assert.Greater(t, time.Until(next), 50*time.Minute, "the wait of a refusal, not of an outage")
		})
	}
}

// tray.log records why a check failed: the stage and a reason, and no query of a URL.
func TestAFailedCheckLogsItsStageAndReason(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	for name, setup := range map[string]struct {
		set  func(r *rig)
		want string
	}{
		"a list that cannot be read": {func(r *rig) { r.gh.ListBody = bytes.Repeat([]byte(" "), 8<<20+10) }, "check failed at manifest (list):"},
		"the list's server errs":     {func(r *rig) { r.gh.Status["list"] = 503 }, "check failed at manifest (network):"},
	} {
		t.Run(name, func(t *testing.T) {
			buf.Reset()
			r := newAPIRig(t)
			r.publish(Spec{Version: "1.4.131", Sequence: 7})
			setup.set(r)
			res := r.check()
			require.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
			assert.Contains(t, buf.String(), setup.want)
			assert.NotContains(t, buf.String(), "per_page", "no URL query in the log")
		})
	}
}
