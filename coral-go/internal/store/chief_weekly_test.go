package store

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// A weekly reminder (#21085): one day of the week and a time, kept as "Mon 09:00".
func TestChiefCronWeekly(t *testing.T) {
	base := ChiefCheck{Name: "Catch-up", Instruction: "Do it", TargetSession: "s", TargetBoard: "t", NotifyMode: "every_time", Origin: "operator", ScheduleKind: "weekly", At: "Mon 09:00", Timezone: "Europe/Berlin"}
	cron, err := ChiefCron(base)
	require.NoError(t, err)
	require.Equal(t, "0 9 * * 1", cron)
	for day, want := range map[string]string{"Sun": "0", "Wed": "3", "Sat": "6"} {
		c := base
		c.At = day + " 17:45"
		cron, err = ChiefCron(c)
		require.NoError(t, err)
		require.Equal(t, "45 17 * * "+want, cron)
	}
	for _, at := range []string{"", "09:00", "Mon", "Mon 9:00", "Mon 24:00", "Monday 09:00", "mon 09:00", "Mon  09:00", "1 09:00"} {
		c := base
		c.At = at
		_, err = ChiefCron(c)
		require.Error(t, err, at)
	}
}
