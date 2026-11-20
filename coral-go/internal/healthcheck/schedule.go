package healthcheck

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// MinPeriod is the shortest time between two runs of a check; MaxPeriod the longest.
const (
	MinPeriod = 5 * time.Minute
	MaxPeriod = 7 * 24 * time.Hour
)

// Schedule is when a check runs: every Period, or each day at Daily ("HH:MM") in TZ.
type Schedule struct {
	Every string // "30m", "2h"
	Daily string // "09:30"
	TZ    string // an IANA zone; "" is UTC
}

// String is the schedule as the approval row shows it.
func (s Schedule) String() string {
	if s.Every != "" {
		return "every " + s.Every
	}
	tz := s.TZ
	if tz == "" {
		tz = "UTC"
	}
	return "daily at " + s.Daily + " " + tz
}

// Validate says what is wrong with the schedule, in words.
func (s Schedule) Validate() error {
	if (s.Every == "") == (s.Daily == "") {
		return errors.New("give either --every (such as 30m) or --daily HH:MM")
	}
	if s.Every != "" {
		d, err := time.ParseDuration(s.Every)
		if err != nil {
			return fmt.Errorf("%q is not a period (such as 30m or 2h)", s.Every)
		}
		if d < MinPeriod {
			return fmt.Errorf("a check runs at most every %s", MinPeriod)
		}
		if d > MaxPeriod {
			return fmt.Errorf("a check runs at least every %s", MaxPeriod)
		}
		return nil
	}
	if _, err := time.Parse("15:04", s.Daily); err != nil {
		return fmt.Errorf("%q is not a time of day (HH:MM)", s.Daily)
	}
	if _, err := s.location(); err != nil {
		return err
	}
	return nil
}

func (s Schedule) location() (*time.Location, error) {
	if s.TZ == "" || strings.EqualFold(s.TZ, "UTC") {
		return time.UTC, nil
	}
	loc, err := time.LoadLocation(s.TZ)
	if err != nil {
		return nil, fmt.Errorf("%q is not a time zone", s.TZ)
	}
	return loc, nil
}

// Next is the first run after t.
func (s Schedule) Next(t time.Time) time.Time {
	if s.Every != "" {
		d, err := time.ParseDuration(s.Every)
		if err != nil || d < MinPeriod {
			d = MinPeriod
		}
		return t.Add(d)
	}
	loc, err := s.location()
	if err != nil {
		loc = time.UTC
	}
	hm, _ := time.Parse("15:04", s.Daily)
	l := t.In(loc)
	n := time.Date(l.Year(), l.Month(), l.Day(), hm.Hour(), hm.Minute(), 0, 0, loc)
	if !n.After(t) {
		n = time.Date(l.Year(), l.Month(), l.Day()+1, hm.Hour(), hm.Minute(), 0, 0, loc)
	}
	return n.UTC()
}
