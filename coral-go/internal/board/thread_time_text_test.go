package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14726: the thread's times are compared and sorted as text (thread_summary.go compares utc(...) strings), so the text of a later time must sort after the text of an earlier one. RFC3339Nano does not
// (it drops trailing zeros): ".1Z" sorted after ".12Z" and "...:00Z" after "...:00.5Z".
func TestThreadTimesSortAsTextTheWayTheTimesDo(t *testing.T) {
	later := [][2]string{ // {earlier, later}
		{"2026-11-08T10:00:00.1Z", "2026-11-08T10:00:00.12Z"},
		{"2026-11-08T10:00:00Z", "2026-11-08T10:00:00.5Z"},
		{"2026-11-08T10:00:00.5Z", "2026-11-08T10:00:00.500001Z"},
		{"2026-11-08T10:00:00.999Z", "2026-11-08T10:00:01Z"},
		{"2026-11-08T10:00:00Z", "2026-11-08T11:30:00+01:00"}, // 10:30Z
	}
	for _, p := range later {
		assert.Less(t, utc(p[0]), utc(p[1]), "%s is before %s, as text too", p[0], p[1])
	}
	for _, s := range []string{"2026-11-08T10:00:00Z", "2026-11-08T10:00:00.123456789Z", "2026-11-08T11:00:00+01:00"} {
		got := utc(s)
		assert.Len(t, got, len("2026-11-08T10:00:00.000000Z"), s)
		assert.Equal(t, byte('Z'), got[len(got)-1], s)
	}
	assert.Equal(t, "2026-11-08T10:00:00.000000Z", utc("2026-11-08T11:00:00+01:00"), "an offset is brought to UTC")
	assert.Equal(t, "not a time", utc("not a time"), "an unparsable value is passed through")
}
