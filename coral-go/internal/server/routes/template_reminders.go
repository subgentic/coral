package routes

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/store"
)

// Reminders in team templates (#21019, brief task 5): a role of a template may carry reminders, and launching the team creates them for the member it starts. They are
// the same reminders the person sets by hand (origin "operator", seen in 'coral-board remind list'), made under the limits of an agent's own: a recurring one runs
// no faster than minSelfReminderMinutes, one agent has at most maxAgentReminders, a role brings at most maxTemplateRemindersPerRole, and the text is held to the
// reminders' own rules (no secret, no sign-in link). A template can come from someone else, so what it brings is never trusted past those limits. A time
// that is not a recurrence (a one-time reminder) has no meaning in a template and is left out.

// maxTemplateRemindersPerRole is how many reminders one role of a template may bring.
const maxTemplateRemindersPerRole = 5

// templateReminder is one reminder of a template's role.
type templateReminder struct {
	Text         string `json:"text"`
	Kind         string `json:"kind"` // every, daily, weekdays, weekly or cron (the line is in at)
	At           string `json:"at"`   // "09:00", for daily and weekdays
	EveryMinutes int    `json:"every_minutes"`
	Timezone     string `json:"timezone"`
	NoWake       bool   `json:"no_wake"`
}

// SetTemplateReminders wires the launch of a team to the reminders' handler: add makes one member's template reminders and says how many it made and why it left each other out.
func (h *SessionsHandler) SetTemplateReminders(add func(ctx context.Context, board, sessionID string, rs []templateReminder) (made int, left []string)) {
	h.templateReminders = add
}

// AddTemplateReminders creates the reminders a template's role brings for the member started in sessionID on board, and says how many it made and why it left each other one out.
func (h *ChiefChecksHandler) AddTemplateReminders(ctx context.Context, board, sessionID string, rs []templateReminder) (made int, left []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	active := 0
	if checks, err := h.sched.ChiefChecks(ctx); err == nil {
		for _, c := range checks {
			if c.Enabled && c.IsReminder() && c.TargetSession == sessionID {
				active++
			}
		}
	}
	for i, r := range rs {
		why := func(reason string) { left = append(left, fmt.Sprintf("reminder %d: %s", i+1, reason)) }
		if i >= maxTemplateRemindersPerRole {
			why(fmt.Sprintf("a role brings at most %d", maxTemplateRemindersPerRole))
			continue
		}
		text := strings.TrimSpace(clitext.Clean(r.Text))
		if text == "" {
			why("no text")
			continue
		}
		if hasSignInLink(text) {
			why("a sign-in link is not saved in a reminder")
			continue
		}
		if safe, ok := redactChiefText(text); !ok || safe != text {
			why("it holds a secret (or could not be checked), so it was not saved")
			continue
		}
		check := store.ChiefCheck{Instruction: text, TargetBoard: board, TargetSession: sessionID, NotifyMode: "every_time", WakeIfAsleep: !r.NoWake, Enabled: true,
			Timezone: zoneOrThisComputers(r.Timezone), Origin: "operator", CreatedBy: "the team template"}
		check.Name = strings.Join(strings.Fields(text), " ")
		if utf8.RuneCountInString(check.Name) > 60 {
			check.Name = string([]rune(check.Name)[:60])
		}
		switch r.Kind {
		case "every":
			check.ScheduleKind, check.EveryMinutes = "interval", r.EveryMinutes
			if r.EveryMinutes < minSelfReminderMinutes {
				why("a reminder can repeat at most every 15 minutes")
				continue
			}
		case "daily", "weekdays", "weekly", "cron":
			check.ScheduleKind, check.At = r.Kind, r.At
		default:
			why("a template's reminder repeats: every, daily, weekdays, weekly or cron")
			continue
		}
		line, err := store.ChiefCron(check)
		if err != nil {
			why(err.Error())
			continue
		}
		if r.Kind == "cron" {
			check.At = line
		}
		if r.Kind == "cron" && store.CronLeastGap(line) < minSelfReminderMinutes*time.Minute {
			why("a reminder can repeat at most every 15 minutes")
			continue
		}
		if active >= maxAgentReminders {
			why("the agent already has 20 active reminders")
			continue
		}
		if _, err := h.sched.SaveChiefCheck(ctx, check); err != nil {
			why("it could not be saved")
			continue
		}
		active++
		made++
	}
	return made, left
}

// zoneOrThisComputers is the zone a template's reminder names, or this computer's when it names none (a template has no way to know the zone of the person who launches it): TZ, then
// /etc/localtime's link, then UTC.
func zoneOrThisComputers(named string) string {
	if z := strings.TrimSpace(named); z != "" {
		return z
	}
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" && tz != "Local" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if link, err := os.Readlink("/etc/localtime"); err == nil {
		if i := strings.Index(link, "zoneinfo/"); i >= 0 {
			if _, err := time.LoadLocation(link[i+len("zoneinfo/"):]); err == nil {
				return link[i+len("zoneinfo/"):]
			}
		}
	}
	return "UTC"
}
