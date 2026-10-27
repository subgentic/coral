package board

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9685: the message search index is on unless CORAL_BOARD_SEARCH_INDEX is off.
func TestMessageSearchIndexIsOnUnlessTheSettingIsOff(t *testing.T) {
	for v, want := range map[string]bool{
		"": true, "on": true, "ON": true, "1": true, "true": true, "yes": true, "anything else": true, "  ": true,
		"off": false, "OFF": false, "Off": false, "0": false, "false": false, "False": false, "no": false, " off ": false,
	} {
		t.Setenv(messageSearchIndexEnv, v)
		assert.Equal(t, want, messageSearchIndexWanted(), "CORAL_BOARD_SEARCH_INDEX=%q", v)
	}
}

// With nothing set, a store builds the index in the background at open and says so; with the switch off it does not, and drops one that exists.
func TestMessageSearchIndexDefaultBuildsAndTheSwitchDropsIt(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "board_default.db")
	open := func() *Store {
		s, err := NewStoreWithKey(path, "")
		require.NoError(t, err)
		return s
	}
	t.Setenv(messageSearchIndexEnv, "off")
	s := open()
	_, err := sub(s, ctx, "proj", "dev", "Dev")
	require.NoError(t, err)
	for i := 0; i < 30; i++ {
		_, err = s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s %d", ftsTexts[i%len(ftsTexts)], i), nil)
		require.NoError(t, err)
	}
	st := s.MessageSearchIndexStatus(ctx)
	assert.Equal(t, MessageSearchIndexStatus{Setting: "off", Available: true, State: "off", SizeBytes: 0}, st)
	require.NoError(t, s.Close())

	t.Setenv(messageSearchIndexEnv, "") // nothing set
	s = open()
	require.Eventually(t, func() bool { return s.MessageSearchIndexState() == "ready" }, 10*time.Second, 5*time.Millisecond, "built at open by default")
	st = s.MessageSearchIndexStatus(ctx)
	assert.Equal(t, "on", st.Setting)
	assert.True(t, st.Available)
	assert.Equal(t, "ready", st.State)
	assert.Greater(t, st.SizeBytes, int64(0), "the index has a size")
	raw, err := json.Marshal(st)
	require.NoError(t, err)
	assert.JSONEq(t, fmt.Sprintf(`{"setting":"on","available":true,"state":"ready","size_bytes":%d}`, st.SizeBytes), string(raw))
	require.NoError(t, s.Close())

	t.Setenv(messageSearchIndexEnv, "off")
	s = open()
	defer s.Close()
	require.Eventually(t, func() bool { return !s.messageIndexExists(ctx) }, 10*time.Second, 5*time.Millisecond, "off drops it")
	st = s.MessageSearchIndexStatus(ctx)
	assert.Equal(t, MessageSearchIndexStatus{Setting: "off", Available: true, State: "off", SizeBytes: 0}, st)
}
