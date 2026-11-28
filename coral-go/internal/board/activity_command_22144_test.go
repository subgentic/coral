package board

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #22144: an answered permission prompt's row keeps its command (already redacted by the caller), cut to activityCommandCap with "…" and CommandCut; any other row keeps none; the command is in the
// row's hash, and a row without one hashes as before.
func TestAPermissionRowKeepsItsCommandCutAndHashed(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	meta := func(cmd string) ActivityMeta { return ActivityMeta{Actor: "local", Source: "local", Command: cmd} }

	require.NoError(t, s.RecordActivity(ctx, meta("go test ./...  \n  -count=1"), ActPromptAllow, "agent", "a1", "", ""))
	long := strings.Repeat("x", activityCommandCap+40)
	require.NoError(t, s.RecordActivity(ctx, meta(long), ActPromptReject, "agent", "a1", "", ""))
	require.NoError(t, s.RecordActivity(ctx, meta("never kept"), ActPromptAnswer, "agent", "a1", "", ""))
	require.NoError(t, s.RecordActivity(ctx, meta("never kept"), ActApprove, "file", "f1", "", "team"))

	rows, _, err := s.ActivityPage(ctx, ActivityFilter{Limit: ActivityMaxLimit})
	require.NoError(t, err)
	require.Len(t, rows, 4)
	by := map[string]OperatorAction{}
	for _, r := range rows {
		by[r.Action] = r
	}
	assert.Equal(t, "go test ./... -count=1", by[ActPromptAllow].Command, "cleaned like any row text")
	assert.False(t, by[ActPromptAllow].CommandCut)
	cut := by[ActPromptReject]
	assert.True(t, cut.CommandCut)
	assert.Equal(t, activityCommandCap, utf8.RuneCountInString(cut.Command))
	assert.True(t, strings.HasSuffix(cut.Command, "…"))
	assert.Empty(t, by[ActPromptAnswer].Command, "only an allow or a reject keeps a command")
	assert.Empty(t, by[ActApprove].Command)

	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact)

	plain := OperatorAction{At: "t", Actor: "local", Action: ActApprove}
	with := plain
	with.Command = "ls"
	assert.NotEqual(t, activityHash("", plain), activityHash("", with), "the command is in the hash")
	cutToo := with
	cutToo.CommandCut = true
	assert.NotEqual(t, activityHash("", with), activityHash("", cutToo))
	_, err = s.db.ExecContext(ctx, `UPDATE operator_actions SET command = 'ls -la' WHERE action = ?`, ActPromptAllow)
	require.NoError(t, err)
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.False(t, chk.Intact, "an edited command breaks the chain")
}
