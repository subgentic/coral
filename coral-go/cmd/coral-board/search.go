package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/clitext"
)

const searchUsage = `Usage: coral-board search "<text>" [--source messages,tasks,goals,history] [--state S] [--goal N] [--assignee NAME]
                          [--from NAME] [--mentions NAME] [--agent NAME] [--author user|assistant] [--since T] [--until T] [--sort newest|oldest] [--limit N] [--cursor C] [--json]
                          [--system] [--team | --all | --operator-history]
Searches this team's messages, tasks (title, body, completion message) and goals (title, outcome, done-when) and your past chats at once; --source picks some.
Every word must be there, in any order, in any field ("staging certificate" finds a task about the certificate of the staging cluster); put "a quoted phrase" in
double quotes inside the text to keep its words together. The best matches come first; --sort newest or oldest orders by time instead.
Coral's own notices (the task queue's) are left out; --system brings them back. A hit shows its source, id, time (UTC), state and goal, and the words around the match.
--since and --until take a time such as 2026-11-17T09:00:00Z, a date (2026-11-17, UTC) or how long ago (30m, 6h, 2d, 1w).
--agent and --author narrow the past chats (an agent's name; who spoke). Chat turns in full: coral-agent history search / context.`

// cmdSearch is `coral-board search` (#11005, phase (a)): the agent's search of the messages of its OWN board (the board it was launched on), with the dashboard search's filters and paging. A hit's context is
// `coral-board read --id <id>`. --team, --all and --operator-history ask for a wider reach on purpose; the server checks them against the operator-set level and refuses a reach above it with a line meant
// for the Operator (relayed as it is, exit 5): never a quiet narrowing to what the agent may read.
func cmdSearch() {
	args := os.Args[2:]
	valueFlags := map[string]bool{"from": true, "mentions": true, "since": true, "until": true, "sort": true, "limit": true, "cursor": true, "source": true, "state": true, "goal": true, "assignee": true, "agent": true, "author": true}
	text, rest := splitTitle(args, valueFlags) // options may stand after the text, as they do for task add
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	from, mentions := fs.String("from", "", ""), fs.String("mentions", "", "")
	since, until, sortBy := fs.String("since", "", ""), fs.String("until", "", ""), fs.String("sort", "", "")
	limit, cursor := fs.String("limit", "", ""), fs.String("cursor", "", "")
	source, state, goal, assignee := fs.String("source", "", ""), fs.String("state", "", ""), fs.String("goal", "", ""), fs.String("assignee", "", "")
	agent, author := fs.String("agent", "", ""), fs.String("author", "", "")
	asJSON := fs.Bool("json", false, "")
	team, all, op := fs.Bool("team", false, ""), fs.Bool("all", false, ""), fs.Bool("operator-history", false, "")
	system := fs.Bool("system", false, "")
	clihelp.ParseFlags(fs, rest, func() string { return searchUsage })
	if strings.TrimSpace(text) == "" || fs.NArg() != 0 {
		fmt.Fprintf(os.Stderr, "search needs the text to look for, as one argument\n%s\n", searchUsage)
		clierr.Exit1()
	}
	reach, n := "", 0
	for _, c := range []struct {
		on   *bool
		name string
	}{{team, "team"}, {all, "all"}, {op, "operator"}} {
		if *c.on {
			reach = c.name
			n++
		}
	}
	if n > 1 {
		fmt.Fprintf(os.Stderr, "Only one of --team, --all and --operator-history\n%s\n", searchUsage)
		clierr.Exit1()
	}
	vals := url.Values{"q": {text}}
	for k, v := range map[string]string{"from": *from, "mentions": *mentions, "since": searchTime(*since, time.Now()), "until": searchTime(*until, time.Now()), "sort": *sortBy, "limit": *limit, "cursor": *cursor, "source": *source, "state": *state, "goal": *goal, "assignee": *assignee, "agent": *agent, "author": *author} {
		if v != "" {
			vals.Set(k, v)
		}
	}
	if reach != "" {
		vals.Set("reach", reach)
	}
	if *system {
		vals.Set("system", "1")
	}
	args = []string{text}
	data, status, err := apiCallRawAt("/api/agent", "GET", "/board/search?"+vals.Encode(), nil, 20*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		failFromServer(data, status, nil)
		return
	}
	if *asJSON {
		fmt.Println(strings.TrimSpace(string(data)))
		return
	}
	var out struct {
		Board      string           `json:"board"`
		Total      int              `json:"total"`
		NextCursor string           `json:"next_cursor"`
		Truncated  bool             `json:"truncated"`
		Messages   []map[string]any `json:"messages"`
		Results    []map[string]any `json:"results"`
		More       bool             `json:"more"`
		WorkScope  string           `json:"work_scope"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if hasResults(data) {
		printResults(out.Board, args[0], out.Results, out.More, out.NextCursor, out.WorkScope)
		return
	}
	if len(out.Messages) == 0 {
		fmt.Printf("No messages match %q on board %s.\n", args[0], out.Board)
		return
	}
	fmt.Printf("%d matches on board %s (showing %d):\n", out.Total, out.Board, len(out.Messages))
	for _, m := range out.Messages {
		who := clitext.Clean(str(m["subscriber_id"]))
		if t := clitext.Clean(str(m["job_title"])); t != "" && t != who {
			who += " (" + t + ")"
		}
		fmt.Printf("  #%-6.0f %s  %s: %s\n", num(m["id"]), whenShort(str(m["created_at"])), who, hitExcerpt(str(m["content"]), args[0]))
	}
	if out.Truncated {
		fmt.Println("The search stopped at its bound: narrow it with --since, --from or a longer text.")
	}
	if out.NextCursor != "" {
		fmt.Printf("More: coral-board search %q --cursor %s\n", args[0], out.NextCursor)
	}
	fmt.Println("Context around a hit: coral-board read --id <id>")
}

// whenShort is a time as "2026-10-20 10:00Z": UTC, marked so (the Z is the one --since and --until take), what a person reading a list needs.
func whenShort(ts string) string {
	if t, err := time.Parse(time.RFC3339, ts); err == nil {
		return t.UTC().Format("2006-01-02 15:04") + "Z"
	}
	return ts
}

// searchTime is a --since or --until as the server reads it, an RFC 3339 time: one that is already is kept, a date (2026-11-17) is that day's start in UTC, and
// "30m", "6h", "2d" or "1w" is that long before now. Anything else goes to the server as it is, which names what it expects.
func searchTime(v string, now time.Time) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if _, err := time.Parse(time.RFC3339, v); err == nil {
		return v
	}
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	if n := len(v); n >= 2 {
		if count, err := strconv.Atoi(v[:n-1]); err == nil && count > 0 {
			unit := map[byte]time.Duration{'m': time.Minute, 'h': time.Hour, 'd': 24 * time.Hour, 'w': 7 * 24 * time.Hour}[v[n-1]]
			if unit > 0 && time.Duration(count) <= time.Duration(math.MaxInt64)/unit {
				return now.Add(-time.Duration(count) * unit).UTC().Format(time.RFC3339)
			}
		}
	}
	return v
}

// hitExcerpt is a message on one line (control characters removed, whitespace joined), cut to about 160 characters around the first place the text occurs.
func hitExcerpt(content, query string) string {
	text := strings.Join(strings.Fields(clitext.Clean(content)), " ")
	const width = 160
	r := []rune(text)
	if len(r) <= width {
		return text
	}
	start := 0
	if i := strings.Index(strings.ToLower(text), strings.ToLower(strings.TrimSpace(query))); i > 0 {
		start = len([]rune(text[:i])) - 40
	}
	if start < 0 {
		start = 0
	}
	if start+width > len(r) {
		start = len(r) - width
	}
	out := string(r[start : start+width])
	if start > 0 {
		out = "…" + out
	}
	if start+width < len(r) {
		out += "…"
	}
	return out
}

// hasResults says the server answered with the one result list (tasks, goals and messages together); an older server answers with messages only.
func hasResults(data []byte) bool {
	var probe struct {
		Results *json.RawMessage `json:"results"`
	}
	return json.Unmarshal(data, &probe) == nil && probe.Results != nil
}

// printResults is the one list, a hit a line: the source and id, the time, the state, then the title and the words around the match.
func printResults(boardName, text string, results []map[string]any, more bool, nextCursor, workScope string) {
	if len(results) == 0 {
		fmt.Printf("No messages, tasks, goals or past chats match %q on board %s.\n", text, boardName)
		return
	}
	fmt.Printf("%d matches on board %s:\n", len(results), boardName)
	for _, r := range results {
		src := clitext.Clean(str(r["source"]))
		head := fmt.Sprintf("  %s #%.0f %s", src, num(r["id"]), whenShort(str(r["at"])))
		if src == "history" { // a turn of a past chat: the session and the turn's place in it, for coral-agent history context
			head = fmt.Sprintf("  history %s@%.0f %s", clitext.Clean(str(r["session"])), num(r["id"]), whenShort(str(r["at"])))
		}
		if st := clitext.Clean(str(r["state"])); st != "" {
			head += " [" + st + "]"
		}
		if g := num(r["goal_id"]); g > 0 { // a task's goal: "is any of this goal's work still open?"
			head += fmt.Sprintf(" goal #%.0f", g)
		}
		line := head + "  " + clitext.Clean(str(r["title"]))
		if sn := strings.Join(strings.Fields(clitext.Clean(str(r["snippet"]))), " "); sn != "" && sn != clitext.Clean(str(r["title"])) { // the title is already there
			line += ": " + sn
		}
		fmt.Println(line)
	}
	if more {
		fmt.Println("There are more: narrow it with --source, --state, --goal or --since/--until, or raise --limit.")
	}
	if nextCursor != "" {
		fmt.Printf("More messages: coral-board search %q --source messages --cursor %s\n", text, nextCursor)
	}
	if workScope != "" {
		fmt.Printf("Tasks and goals: %s (--team, --all and --operator-history widen only the messages and past chats).\n", clitext.Clean(workScope))
	}
	fmt.Println("A message: coral-board read --id <id>. A task: coral-board task detail <id>. A goal: coral-board goal show <id>. A past chat turn (history <session>@<n>): coral-agent history context <session> <n>.")
}
