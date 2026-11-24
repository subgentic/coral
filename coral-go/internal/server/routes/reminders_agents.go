package routes

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// The Operator's view of reminders per agent, for Settings (#19288): each member's count, when the next one fires, and a switch that turns that agent's reminders off and back on without deleting them. The person's only: never an agent, never through the Hub.

type reminderAgentRow struct {
	SessionID string `json:"session_id"`
	Name      string `json:"name"`
	Count     int    `json:"count"`   // reminders set for it that are still to fire
	Active    int    `json:"active"`  // of those, how many are not switched off
	NextAt    string `json:"next_at"` // RFC 3339, the soonest of the active ones; "" when none
}

// nextFire is when a reminder next fires after now, "" when it cannot say.
func nextFire(c store.ChiefCheck, now time.Time) time.Time {
	loc, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return time.Time{}
	}
	switch c.ScheduleKind {
	case "once":
		at, err := time.ParseInLocation("2006-01-02T15:04", c.At, loc)
		if err != nil {
			return time.Time{}
		}
		return at
	case "interval":
		if c.EveryMinutes <= 0 {
			return time.Time{}
		}
		m := time.Duration(c.EveryMinutes) * time.Minute
		return now.Truncate(m).Add(m)
	case "daily", "weekdays", "weekly":
		at, wd := c.At, -1
		if c.ScheduleKind == "weekly" {
			name, rest, _ := strings.Cut(c.At, " ")
			n, ok := store.WeekdayNumber(name)
			if !ok {
				return time.Time{}
			}
			at, wd = rest, n
		}
		clock, err := time.Parse("15:04", at)
		if err != nil {
			return time.Time{}
		}
		local := now.In(loc)
		for d := 0; d < 8; d++ {
			day := local.AddDate(0, 0, d)
			if c.ScheduleKind == "weekdays" && (day.Weekday() == time.Saturday || day.Weekday() == time.Sunday) {
				continue
			}
			if wd >= 0 && int(day.Weekday()) != wd {
				continue
			}
			t := time.Date(day.Year(), day.Month(), day.Day(), clock.Hour(), clock.Minute(), 0, 0, loc)
			if t.After(now) {
				return t
			}
		}
	}
	return time.Time{}
}

func (h *ChiefChecksHandler) reminderAgents(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	boardName := strings.TrimSpace(r.URL.Query().Get("board"))
	if boardName == "" {
		errBadRequest(w, "name the team: ?board=<project>")
		return
	}
	subs, err := h.sessions.bs.ListSubscribers(r.Context(), boardName)
	if err != nil {
		errInternalServer(w, "could not read the team")
		return
	}
	checks, err := h.sched.ChiefChecks(r.Context())
	if err != nil {
		errInternalServer(w, "could not read the reminders")
		return
	}
	now := h.now()
	rows := []reminderAgentRow{}
	index := map[string]int{}
	for _, s := range subs {
		if s.IsActive == 0 || strings.TrimSpace(s.JobTitle) == "" || s.SubscriberID == "Operator" {
			continue
		}
		sid := naming.SessionIDFromName(s.SessionName)
		if sid == "" {
			continue
		}
		if _, dup := index[sid]; dup {
			continue
		}
		index[sid] = len(rows)
		rows = append(rows, reminderAgentRow{SessionID: sid, Name: clitext.Clean(s.JobTitle)})
	}
	soonest := map[string]time.Time{}
	for _, ch := range checks {
		i, ok := index[ch.TargetSession]
		if !ok || ch.TargetBoard != boardName || !ch.IsReminder() || !ch.Enabled {
			continue
		}
		rows[i].Count++
		if ch.Paused {
			continue
		}
		rows[i].Active++
		if t := nextFire(ch, now); !t.IsZero() && (soonest[ch.TargetSession].IsZero() || t.Before(soonest[ch.TargetSession])) {
			soonest[ch.TargetSession] = t
		}
	}
	for sid, t := range soonest {
		rows[index[sid]].NextAt = t.UTC().Format(time.RFC3339)
	}
	writeJSON(w, 200, map[string]any{"agents": rows})
}

func (h *ChiefChecksHandler) reminderAgentSwitch(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var b struct {
		Board string `json:"board"`
		On    *bool  `json:"on"`
	}
	if err := decodeJSONStrict(r, &b); err != nil || b.On == nil || strings.TrimSpace(b.Board) == "" {
		errBadRequest(w, `send {"board": "<project>", "on": true|false}`)
		return
	}
	sid := chi.URLParam(r, "sessionID")
	h.mu.Lock()
	defer h.mu.Unlock()
	n, err := h.sched.SetRemindersPaused(r.Context(), strings.TrimSpace(b.Board), sid, !*b.On)
	if err != nil {
		errInternalServer(w, "could not change the reminders")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "changed": n, "on": *b.On})
}
