package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/clitext"
)

const remindUsageText = `Usage: coral-board remind <add|list|show|done|cancel> ...

  remind add "<text>" (--in 2h | --at <time> | --every 30m | --daily 09:00 | --weekdays 09:00)
             [--to <member>] [--board <project>] [--tz <zone>] [--no-wake]
      A reminder for an agent: Coral tells it the text at that time, through the board, and the reminder stays open
      until it runs 'remind done'. You are the agent unless --to names another member of the team.
        --in 2h, --at 2026-11-18 09:00, --at 09:00   once (--at 09:00 is the next time the clock shows it)
        --every 15m                                  repeat every 5, 15, 30 or 60 minutes (an agent's own: 15 or more)
        --daily 09:00, --weekdays 09:00              every day, or Monday to Friday, at that time in --tz
      Who may: the Operator (any agent), an agent (for itself), the team's Orchestrator (for a member, while the
      Operator's grant is on). --no-wake: do not wake the agent if it is asleep. An agent keeps at most 20.
  remind list [--team] [--board <project>]    Your reminders (--team: the team's, the Orchestrator only)
  remind show <id>                            One reminder and where it stands
  remind done <id>                            Say a reminder is done: it stays closed until its next time
  remind cancel <id>                          Remove a reminder`

func cmdRemind() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, remindUsageText)
		os.Exit(2)
	}
	sub, args := os.Args[2], os.Args[3:]
	switch sub {
	case "add":
		remindAdd(args)
	case "list":
		remindList(args)
	case "show":
		remindShow(args)
	case "done":
		remindIDCall(args, "POST", "/done", "finishing the reminder", func(out map[string]any, id string) {
			if resolved, _ := out["resolved"].(bool); resolved {
				fmt.Printf("Reminder %s is done.\n", id)
			} else {
				fmt.Printf("Reminder %s has nothing open.\n", id)
			}
		})
	case "cancel":
		remindIDCall(args, "DELETE", "", "cancelling the reminder", func(_ map[string]any, id string) { fmt.Printf("Reminder %s is cancelled.\n", id) })
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown remind command %q.\n%s\n", sub, remindUsageText)
		os.Exit(2)
	}
}

// remindProject is the team the command is about: --board, else the one this terminal joined.
func remindProject(flagged string) string {
	if p := strings.TrimSpace(flagged); p != "" {
		return p
	}
	if st := loadState(); st != nil {
		return st.Project
	}
	return ""
}

func remindCall(method, path string, body any, what string, ok ...int) map[string]any {
	data, status, err := apiCallRawAt("/api", method, path, body, 10*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	for _, s := range ok {
		if status == s {
			out := map[string]any{}
			_ = json.Unmarshal(data, &out)
			return out
		}
	}
	fmt.Fprintf(os.Stderr, "Error %s: %s\n", what, clierr.Describe(nil, status, data))
	clierr.Exit1()
	return nil
}

// localZone is the computer's time zone as an IANA name, "" when it cannot be told (TZ, then /etc/localtime's link).
func localZone() string {
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
	return ""
}

// everyMinutes reads "15m", "1h" or "30" as minutes.
func everyMinutes(s string) (int, error) {
	s = strings.TrimSpace(s)
	if n, err := strconv.Atoi(s); err == nil {
		return n, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 || d%time.Minute != 0 {
		return 0, fmt.Errorf("%q is not a number of minutes: use 15m or 1h", s)
	}
	return int(d / time.Minute), nil
}

// buildReminder turns the options into the API's body; a bad combination is an error.
func buildReminder(text, in, at, every, daily, weekdays, tz string, now time.Time) (map[string]any, string, error) {
	n := 0
	for _, v := range []string{in, at, every, daily, weekdays} {
		if v != "" {
			n++
		}
	}
	if text == "" {
		return nil, "", errors.New("say what to be reminded of: coral-board remind add \"<text>\" --in 2h")
	}
	if n != 1 {
		return nil, "", errors.New("give exactly one of --in, --at, --every, --daily, --weekdays")
	}
	body := map[string]any{"text": text}
	switch {
	case in != "" || at != "":
		w := in
		if w == "" {
			w = at
		}
		t, err := parseWhen(w, now)
		if err != nil {
			return nil, "", err
		}
		body["kind"], body["timezone"], body["at"] = "once", "UTC", t.UTC().Format("2006-01-02T15:04")
		return body, "once, at " + t.Local().Format("2006-01-02 15:04"), nil
	case every != "":
		m, err := everyMinutes(every)
		if err != nil {
			return nil, "", err
		}
		body["kind"], body["every_minutes"] = "every", m
		body["timezone"] = "UTC"
		return body, fmt.Sprintf("every %d minutes", m), nil
	default:
		kind, at := "daily", daily
		if weekdays != "" {
			kind, at = "weekdays", weekdays
		}
		zone := strings.TrimSpace(tz)
		if zone == "" {
			zone = localZone()
		}
		if zone == "" {
			return nil, "", errors.New("could not tell this computer's time zone: add --tz Europe/Berlin (or set TZ)")
		}
		body["kind"], body["at"], body["timezone"] = kind, at, zone
		return body, fmt.Sprintf("%s at %s (%s)", map[string]string{"daily": "every day", "weekdays": "Monday to Friday"}[kind], at, zone), nil
	}
}

func remindAdd(args []string) {
	text, rest := splitTitle(args, map[string]bool{"in": true, "at": true, "every": true, "daily": true, "weekdays": true, "tz": true, "to": true, "board": true})
	fs := flag.NewFlagSet("remind add", flag.ContinueOnError)
	in := fs.String("in", "", "once, this long from now (30m, 2h, 3d)")
	at := fs.String("at", "", "once, at this time")
	every := fs.String("every", "", "repeat every 5, 15, 30 or 60 minutes")
	daily := fs.String("daily", "", "every day at HH:mm")
	weekdays := fs.String("weekdays", "", "Monday to Friday at HH:mm")
	tz := fs.String("tz", "", "the time zone for --daily and --weekdays")
	to := fs.String("to", "", "the member it is for (default: you)")
	boardFlag := fs.String("board", "", "the team (default: the one you joined)")
	noWake := fs.Bool("no-wake", false, "do not wake the agent if it is asleep")
	clihelp.ParseFlags(fs, rest, func() string { return remindUsageText })
	body, when, err := buildReminder(strings.TrimSpace(text), *in, *at, *every, *daily, *weekdays, *tz, time.Now())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(2)
	}
	project := remindProject(*boardFlag)
	if project == "" {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role> or give --board <project>")
		clierr.Exit1()
	}
	body["board"] = project
	if t := strings.TrimSpace(*to); t != "" {
		body["to"] = t
	}
	if *noWake {
		body["no_wake"] = true
	}
	out := remindCall("POST", "/reminders", body, "adding the reminder", 201)
	who := clitext.Clean(fmt.Sprint(out["target_name"]))
	if who == "" || who == "<nil>" {
		who = "the agent"
	}
	fmt.Printf("Reminder %v for %s: %s.\n", out["id"], who, when)
}

func remindList(args []string) {
	fs := flag.NewFlagSet("remind list", flag.ContinueOnError)
	team := fs.Bool("team", false, "the team's reminders (the Orchestrator)")
	_ = fs.String("board", "", "the team (default: the one you joined)")
	clihelp.ParseFlags(fs, args, func() string { return remindUsageText })
	path := "/reminders"
	if *team {
		path += "?team=1"
	}
	out := remindCall("GET", path, nil, "reading the reminders", 200)
	rows, _ := out["reminders"].([]any)
	if len(rows) == 0 {
		fmt.Println("No reminders.")
		return
	}
	for _, r := range rows {
		m, _ := r.(map[string]any)
		fmt.Println(reminderLine(m))
	}
}

func remindShow(args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Error: give the reminder's number.\n"+remindUsageText)
		os.Exit(2)
	}
	id := strings.TrimPrefix(strings.TrimSpace(args[0]), "#")
	out := remindCall("GET", "/reminders/"+id, nil, "reading the reminder", 200)
	fmt.Println(reminderLine(out))
	fmt.Println("  " + clitext.Clean(fmt.Sprint(out["instruction"])))
}

func remindIDCall(args []string, method, suffix, what string, say func(map[string]any, string)) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Error: give the reminder's number.\n"+remindUsageText)
		os.Exit(2)
	}
	id := strings.TrimPrefix(strings.TrimSpace(args[0]), "#")
	if n, err := strconv.Atoi(id); err != nil || n < 1 {
		fmt.Fprintf(os.Stderr, "Error: %q is not a reminder number.\n", args[0])
		os.Exit(2)
	}
	say(remindCall(method, "/reminders/"+id+suffix, nil, what, 200), id)
}

// reminderLine is one reminder as a line: number, state, schedule, who it is for and its words.
func reminderLine(m map[string]any) string {
	kind := fmt.Sprint(m["schedule_kind"])
	when := kind
	switch kind {
	case "once":
		when = "once " + fmt.Sprint(m["at"]) + " " + fmt.Sprint(m["timezone"])
	case "interval":
		when = fmt.Sprintf("every %v min", m["every_minutes"])
	case "daily", "weekdays":
		when = kind + " " + fmt.Sprint(m["at"]) + " " + fmt.Sprint(m["timezone"])
	}
	state := fmt.Sprint(m["state"])
	if on, _ := m["enabled"].(bool); !on && state == "none" {
		state = "off"
	}
	return fmt.Sprintf("#%v [%s] %s, for %s, set by %s: %s", m["id"], state, when, clitext.Clean(fmt.Sprint(m["target_name"])), clitext.Clean(fmt.Sprint(m["origin"])), clitext.Clean(fmt.Sprint(m["name"])))
}
