package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/clitext"
)

const searchUsage = `Usage: coral-board search "<text>" [--from NAME] [--mentions NAME] [--since T] [--until T] [--sort newest|oldest] [--limit N] [--cursor C] [--json]
                          [--team | --all | --operator-history]`

// cmdSearch is `coral-board search` (#11005, phase (a)): the agent's search of the messages of its OWN board (the board it was launched on), with the dashboard search's filters and paging. A hit's context is
// `coral-board read --id <id>`. --team, --all and --operator-history ask for a wider reach on purpose; the server checks them against the operator-set level and refuses a reach above it with a line meant
// for the Operator (relayed as it is, exit 5): never a quiet narrowing to what the agent may read.
func cmdSearch() {
	args := os.Args[2:]
	valueFlags := map[string]bool{"from": true, "mentions": true, "since": true, "until": true, "sort": true, "limit": true, "cursor": true}
	text, rest := splitTitle(args, valueFlags) // options may stand after the text, as they do for task add
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	from, mentions := fs.String("from", "", ""), fs.String("mentions", "", "")
	since, until, sortBy := fs.String("since", "", ""), fs.String("until", "", ""), fs.String("sort", "", "")
	limit, cursor := fs.String("limit", "", ""), fs.String("cursor", "", "")
	asJSON := fs.Bool("json", false, "")
	team, all, op := fs.Bool("team", false, ""), fs.Bool("all", false, ""), fs.Bool("operator-history", false, "")
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
	for k, v := range map[string]string{"from": *from, "mentions": *mentions, "since": *since, "until": *until, "sort": *sortBy, "limit": *limit, "cursor": *cursor} {
		if v != "" {
			vals.Set(k, v)
		}
	}
	if reach != "" {
		vals.Set("reach", reach)
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
	}
	if err := json.Unmarshal(data, &out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
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

// whenShort is a message's time as "2026-10-20 10:00" (UTC): what a person reading a list needs.
func whenShort(ts string) string {
	if t, err := time.Parse(time.RFC3339, ts); err == nil {
		return t.UTC().Format("2006-01-02 15:04")
	}
	return ts
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
