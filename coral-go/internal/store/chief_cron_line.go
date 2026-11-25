package store

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

// MinCronGapMinutes is how often a Custom (cron) reminder may fire at most: one firing every 5 minutes, the same floor as the Repeat choices (#21330).
const MinCronGapMinutes = 5

var cronLineParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow) // the scheduler's own parser (background.NextFireTime)

// CronLine checks a Custom (cron) reminder's line and returns it as the scheduler will store it (one space between the fields). It takes exactly five fields (minute hour day month weekday), and in them
// only numbers, ranges, lists and steps: no @reboot or other @words, no seconds field, no names (MON, JAN), no ? L W or #. A line that fires more often than every 5 minutes is refused, and the error says so.
func CronLine(line string) (string, error) {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return "", errors.New("write a cron line: minute hour day month weekday")
	}
	if strings.HasPrefix(fields[0], "@") {
		return "", errors.New("use five fields (minute hour day month weekday); @words like @reboot are not taken")
	}
	if len(fields) != 5 {
		return "", fmt.Errorf("a cron line has exactly 5 fields (minute hour day month weekday); this has %d", len(fields))
	}
	if len(line) > 100 {
		return "", errors.New("that cron line is too long")
	}
	for _, f := range fields {
		for _, r := range f {
			if !(r >= '0' && r <= '9') && r != '*' && r != ',' && r != '-' && r != '/' {
				return "", fmt.Errorf("%q: only numbers, *, ranges (1-5), lists (1,3) and steps (*/10) are taken, no names or other signs", f)
			}
		}
	}
	norm := strings.Join(fields, " ")
	sched, err := cronLineParser.Parse(norm)
	if err != nil {
		return "", fmt.Errorf("not a valid cron line: %s", strings.TrimPrefix(err.Error(), "failed to parse int from "))
	}
	least := cronLeastGap(sched)
	if least != 0 && least < MinCronGapMinutes*time.Minute {
		n := int(least / time.Minute)
		return "", fmt.Errorf("that fires every %d minute%s at times; a reminder can repeat at most every %d minutes", n, map[bool]string{true: "", false: "s"}[n == 1], MinCronGapMinutes)
	}
	return norm, nil
}

// CronLeastGap is the smallest gap between two firings of a line CronLine took (0 when it fires once or never in the sample): an agent's own reminder is held to its 15-minute floor with it.
func CronLeastGap(line string) time.Duration {
	sched, err := cronLineParser.Parse(line)
	if err != nil {
		return 0
	}
	return cronLeastGap(sched)
}

// cronLeastGap looks at the first 2000 firings from a leap year's start (so a Feb 29 line is met too). The zone does not matter: a gap this short is the same in every zone.
func cronLeastGap(sched cron.Schedule) time.Duration {
	t, prev, least := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC), time.Time{}, time.Duration(0)
	for i := 0; i < 2000; i++ {
		t = sched.Next(t)
		if t.IsZero() {
			break
		}
		if !prev.IsZero() && (least == 0 || t.Sub(prev) < least) {
			least = t.Sub(prev)
		}
		prev = t
	}
	return least
}
