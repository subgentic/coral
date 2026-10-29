package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

// `coral-board goal brief <ref>` (#11004, Goal #153): one command that briefs an agent on a goal, for a person who points an agent at a goal and wants to talk about it. `goal show` prints every task of
// the goal, the done ones too (31 for one goal), and no artifacts; the brief prints the goal's fields, its OPEN tasks only and every artifact its tasks hold.

const goalBriefUsage = "Usage: coral-board goal brief <goal> [--json]   (a number, #65, goal #65, or the goal page's link)"

// goalRefLinkRe is the goal page's address: .../team/<team>/goals/<id>, optionally after a server (@name) segment, with a query, a fragment or a trailing slash.
var goalRefLinkRe = regexp.MustCompile(`^/(?:@[^/]+/)?team/([^/]+)/goals/([0-9]+)/?$`)

// parseGoalRef reads what a person pastes to name a goal: "65", "#65", "goal #65" (one argument or two) or the goal page's link. The board is the link's team ("" for the other forms, which mean the
// subscribed board). An id is a whole number from 1 up.
func parseGoalRef(args []string) (id int64, board string, err error) {
	ref := strings.TrimSpace(strings.Join(args, " "))
	if ref == "" {
		return 0, "", errors.New("no goal named")
	}
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		u, perr := url.Parse(ref)
		if perr != nil {
			return 0, "", fmt.Errorf("not a goal link: %q", ref)
		}
		m := goalRefLinkRe.FindStringSubmatch(u.Path)
		if m == nil {
			return 0, "", fmt.Errorf("not a goal page link: %q", ref)
		}
		id, perr = strconv.ParseInt(m[2], 10, 64)
		if perr != nil || id <= 0 {
			return 0, "", fmt.Errorf("not a goal number in the link: %q", ref)
		}
		team, uerr := url.PathUnescape(m[1])
		if uerr != nil || team == "" {
			return 0, "", fmt.Errorf("not a team in the link: %q", ref)
		}
		return id, team, nil
	}
	f := strings.Fields(ref)
	if strings.EqualFold(f[0], "goal") {
		f = f[1:]
	}
	if len(f) != 1 {
		return 0, "", fmt.Errorf("not a goal reference: %q", ref)
	}
	id, perr := strconv.ParseInt(strings.TrimPrefix(f[0], "#"), 10, 64)
	if perr != nil || id <= 0 {
		return 0, "", fmt.Errorf("not a goal number: %q", ref)
	}
	return id, "", nil
}

// openTaskStatus is whether a task still has work in it: everything but done (completed) and set aside (skipped).
func openTaskStatus(status string) bool { return status != "completed" && status != "skipped" }

// goalArtifacts is every artifact the tasks that work toward goal hold, open tasks and done ones, in task order then oldest first. The team artifacts list does the collecting (its goal filter, #8579).
func goalArtifacts(st *boardState, goal int64) []map[string]any {
	var rows []map[string]any
	cursor := ""
	for {
		path := "/" + url.PathEscape(st.Project) + "/artifacts?goal=" + strconv.FormatInt(goal, 10) + "&limit=200&sort=oldest"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		data, status, err := apiCallRaw("GET", path, nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		if status != http.StatusOK {
			fmt.Fprintf(os.Stderr, "Error reading the goal's artifacts: %s\n", clierr.Describe(nil, status, data))
			clierr.Exit1()
		}
		var page struct {
			Artifacts  []map[string]any `json:"artifacts"`
			NextCursor string           `json:"next_cursor"`
		}
		_ = json.Unmarshal(data, &page)
		for _, a := range page.Artifacts {
			id, uri := str(a["id"]), str(a["uri"])
			if uri == "" && id != "" {
				uri = "coral://artifacts/" + id // a row with no uri of its own is linked by its id
			}
			if uri == "" {
				continue // a record with nothing to link to (a landed-commit row)
			}
			rows = append(rows, map[string]any{"uri": uri, "name": str(a["name"]), "task_id": a["task_id"], "task_title": str(a["task_title"]), "created_at": str(a["created_at"])})
		}
		if page.NextCursor == "" || len(page.Artifacts) == 0 {
			break
		}
		cursor = page.NextCursor
	}
	sort.SliceStable(rows, func(i, j int) bool { return num(rows[i]["task_id"]) < num(rows[j]["task_id"]) })
	return rows
}

func cmdGoalBrief(st *boardState, args []string) {
	asJSON := clihelp.HasFlag(args, "--json")
	args = clihelp.WithoutFlag(args, "--json")
	id, board, err := parseGoalRef(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n%s\n", err, goalBriefUsage)
		clierr.Exit1()
	}
	if board != "" && board != st.Project {
		other := *st
		other.Project = board // the page's own team: the server decides whether this agent may read it
		st = &other
	}
	data := goalCall("GET", goalPath(st, id, ""), nil, "reading the goal", http.StatusOK)
	var g map[string]any
	if err := json.Unmarshal(data, &g); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	var open []map[string]any
	tasks := fetchTasks(st, id)
	for _, t := range tasks {
		if openTaskStatus(str(t["status"])) {
			open = append(open, t)
		}
	}
	sort.SliceStable(open, func(i, j int) bool { return num(open[i]["id"]) < num(open[j]["id"]) })
	arts := goalArtifacts(st, id)
	if asJSON {
		out := map[string]any{"goal": g, "open_tasks": open, "artifacts": arts,
			"counts": map[string]any{"tasks": len(tasks), "open_tasks": len(open), "artifacts": len(arts)}}
		if open == nil {
			out["open_tasks"] = []map[string]any{}
		}
		if arts == nil {
			out["artifacts"] = []map[string]any{}
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return
	}
	say := func(s string) string { return neutralizeUntrustedMarkers(s) } // a title or an outcome is other people's text, read by an agent
	fmt.Printf("Goal #%d: %s\n", id, say(str(g["title"])))
	line := func(label, key string) {
		if v := str(g[key]); v != "" {
			fmt.Printf("  %-12s %s\n", label+":", say(v))
		}
	}
	line("State", "state")
	line("Driver", "driver")
	line("Outcome", "outcome")
	line("Done when", "done_when")
	line("Blocked on", "blocked_on")
	fmt.Printf("  %-12s %d, %d open\n", "Tasks:", len(tasks), len(open))
	fmt.Println()
	if len(open) == 0 {
		fmt.Println("No open tasks.")
	} else {
		fmt.Println("Open tasks:")
		for _, t := range open {
			assignee := "—"
			if a := str(t["assigned_to"]); a != "" {
				assignee = a
			}
			fmt.Printf("  #%-5.0f %-14s %-18s %s\n", num(t["id"]), str(t["status"]), say(assignee), say(str(t["title"])))
		}
	}
	fmt.Println()
	if len(arts) == 0 {
		fmt.Println("No artifacts yet.")
		return
	}
	fmt.Printf("Artifacts (%d), from this goal's tasks, open and done:\n", len(arts))
	for _, a := range arts {
		fmt.Printf("  #%-5.0f %s  %s  (%s)\n", num(a["task_id"]), str(a["uri"]), say(str(a["name"])), say(str(a["task_title"])))
	}
}
