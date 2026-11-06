package store_test

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13834: a list kept in a setting is edited under one lock with the PUT writer, so neither loses the other, and the oldest entries go at the cap.
func TestEditSettingListKeepsTheNewestAtTheCapAndEvictsTheOldest(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	for i := 1; i <= 201; i++ {
		_, err := ss.EditSettingList(ctx, "goal_done_hidden", 200, func(l []string) []string { return append(l, "t|"+strconv.Itoa(i)+"|*") })
		require.NoError(t, err)
	}
	st, _ := ss.GetSettings(ctx)
	list, err := ss.EditSettingList(ctx, "goal_done_hidden", 200, func(l []string) []string { return l })
	require.NoError(t, err)
	require.Len(t, list, 200, "the 201st entry pushes the oldest out")
	assert.Equal(t, "t|2|*", list[0])
	assert.Equal(t, "t|201|*", list[199])
	assert.Contains(t, st["goal_done_hidden"], "t|201|*")
}

func TestEditSettingListReadsAnythingButAListAsEmpty(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "goal_done_read", "not json"))
	list, err := ss.EditSettingList(ctx, "goal_done_read", 200, func(l []string) []string { return append(l, "x") })
	require.NoError(t, err)
	assert.Equal(t, []string{"x"}, list)
}

func TestEditsAndTheSettingsWriterDoNotLoseEachOther(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, err := ss.EditSettingList(ctx, "goal_done_hidden", 200, func(l []string) []string { return append(l, fmt.Sprintf("t|%d|*", i)) })
			assert.NoError(t, err)
		}()
		go func() {
			defer wg.Done()
			assert.NoError(t, ss.SaveSettings(ctx, map[string]string{"other_" + strconv.Itoa(i): "v"}))
		}()
	}
	wg.Wait()
	list, err := ss.EditSettingList(ctx, "goal_done_hidden", 200, func(l []string) []string { return l })
	require.NoError(t, err)
	assert.Len(t, list, 40, "every edit is kept")
	st, _ := ss.GetSettings(ctx)
	assert.Len(t, st, 41, "and every setting written beside them")
}
