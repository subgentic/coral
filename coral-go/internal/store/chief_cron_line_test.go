package store

import (
	"strings"
	"testing"
)

func TestCronLineTakesTheFiveFieldShapes(t *testing.T) {
	for in, want := range map[string]string{
		"0 9 * * 1-5":        "0 9 * * 1-5",
		"  */5   *  * * *  ": "*/5 * * * *",
		"0,30 8-17 * * *":    "0,30 8-17 * * *",
		"15 10 1 */2 *":      "15 10 1 */2 *",
		"0 0 29 2 *":         "0 0 29 2 *",
	} {
		got, err := CronLine(in)
		if err != nil || got != want {
			t.Errorf("CronLine(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestCronLineRefusesWhatIsNotFiveFields(t *testing.T) {
	for in, why := range map[string]string{
		"":                                     "write a cron line",
		"   ":                                  "write a cron line",
		"@reboot":                              "@words",
		"@daily":                               "@words",
		"0 0 9 * * 1-5":                        "exactly 5 fields",
		"0 9 * *":                              "exactly 5 fields",
		"0 9 * * MON":                          "no names",
		"0 9 * JAN *":                          "no names",
		"0 9 ? * *":                            "no names",
		"0 9 L * *":                            "no names",
		"0 9 * * 1#2":                          "no names",
		"60 9 * * *":                           "not a valid cron line",
		"0 24 * * *":                           "not a valid cron line",
		"0 9 32 * *":                           "not a valid cron line",
		"0 9 * 13 *":                           "not a valid cron line",
		"0 9 * * 7":                            "not a valid cron line", // the scheduler counts Sunday as 0
		"0 9 * * 8":                            "not a valid cron line",
		"*/0 * * * *":                          "not a valid cron line",
		"5-1 * * * *":                          "not a valid cron line",
		"0 9 * * * ; ls":                       "exactly 5 fields",
		"0 9 * * $(id)":                        "no names",
		"CRON_TZ=UTC 0 9 * * *":                "exactly 5 fields",
		strings.Repeat("1,", 80) + "2 * * * *": "too long",
	} {
		if _, err := CronLine(in); err == nil || !strings.Contains(err.Error(), why) {
			t.Errorf("CronLine(%q) error = %v; want one saying %q", in, err, why)
		}
	}
}

func TestCronLineHoldsTheFiveMinuteFloor(t *testing.T) {
	for _, in := range []string{"* * * * *", "*/1 * * * *", "*/2 * * * *", "*/4 * * * *", "0,3 * * * *", "0-10 9 * * *"} {
		_, err := CronLine(in)
		if err == nil || !strings.Contains(err.Error(), "at most every 5 minutes") {
			t.Errorf("CronLine(%q) error = %v; want the 5-minute floor", in, err)
		}
	}
	for _, in := range []string{"*/5 * * * *", "0,5 * * * *", "*/15 * * * *", "0 * * * *", "59,4 23,0 * * *"} {
		if _, err := CronLine(in); err != nil && strings.Contains(err.Error(), "at most every") {
			t.Errorf("CronLine(%q) was held to the floor: %v", in, err)
		}
	}
	// a rare line is still measured: both firings of 29 Feb are a minute apart
	if _, err := CronLine("0,1 0 29 2 *"); err == nil || !strings.Contains(err.Error(), "can be 1 minute apart") {
		t.Errorf("a Feb 29 line two minutes apart passed: %v", err)
	}
}

func TestChiefCronPassesACronCheckThrough(t *testing.T) {
	c := ChiefCheck{Name: "n", Instruction: "i", TargetBoard: "b", TargetSession: "s", NotifyMode: "every_time", Timezone: "Europe/Berlin", ScheduleKind: "cron", At: " 30   9 * * 1-5 "}
	got, err := ChiefCron(c)
	if err != nil || got != "30 9 * * 1-5" {
		t.Fatalf("ChiefCron = %q, %v", got, err)
	}
	c.At = "* * * * *"
	if _, err := ChiefCron(c); err == nil || !strings.Contains(err.Error(), "at most every 5 minutes") {
		t.Errorf("a cron check every minute: %v", err)
	}
	c.At = "@reboot"
	if _, err := ChiefCron(c); err == nil {
		t.Errorf("@reboot passed ChiefCron")
	}
}
