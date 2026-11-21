package main

import (
	"encoding/json"
	"fmt"
	"github.com/subgentic/coral/internal/clierr"
	"net/http"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
)

const healthUsageText = `Usage: coral-board health ack <id>
       coral-board health settings show [--json] [--since 24h]
       coral-board health settings set <key> <value>
       coral-board health settings reset <key>

  ack <id>   Mark an item of the health check handled: the check prints it as [ack <id>].
             It stays off the list until its state changes (the orchestrator or the Operator only).
  settings   Read and tune the team's health check (the orchestrator or the Operator only, on this computer).
             show lists every key with its value, its default and what it accepts (--since 24h adds the changes
             made this way); set changes one key and is refused, with what is accepted, when the value is not;
             reset puts a key back to its default. Keys are the settings' names: landing.wait_min, goal_size.limit,
             unowned_tasks.to, pool_review.text ... Every change is logged with who made it.`

// cmdHealth: coral-board health ack <id> (#4175 step 3).
func cmdHealth() {
	if len(os.Args) >= 3 && os.Args[2] == "settings" {
		cmdHealthSettings(os.Args[3:])
		return
	}
	if len(os.Args) >= 3 && os.Args[2] == "check" {
		cmdHealthCheck(os.Args[3:])
		return
	}
	if len(os.Args) < 4 || os.Args[2] != "ack" {
		if len(os.Args) >= 3 && (os.Args[2] == "-h" || os.Args[2] == "--help" || os.Args[2] == "help") {
			fmt.Println(healthUsageText)
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, healthUsageText)
		clierr.Exit1()
	}
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role>")
		clierr.Exit1()
	}
	item := os.Args[3]
	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/health/ack", map[string]any{"item": item})
	if err != nil || status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error acknowledging %s: %v %s\n", item, err, data)
		clierr.Exit1()
	}
	fmt.Printf("Acknowledged %s: it stays off the health check until it changes\n", item)
}

// cmdHealthSettings: coral-board health settings show|set|reset (#20136).
func cmdHealthSettings(args []string) {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Println(healthUsageText)
		if len(args) == 0 {
			clierr.Exit1()
		}
		os.Exit(0)
	}
	project := ""
	asJSON := false
	since := ""
	var rest []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--board":
			if i+1 < len(args) {
				project = args[i+1]
				i++
			}
		case "--json":
			asJSON = true
		case "--since":
			if i+1 < len(args) {
				since = args[i+1]
				i++
			}
		default:
			rest = append(rest, args[i])
		}
	}
	if project == "" {
		st := loadState()
		if st == nil {
			fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role>")
			clierr.Exit1()
		}
		project = st.Project
	}
	path := "/" + url.PathEscape(project) + "/health/settings"
	switch args[0] {
	case "show":
		q := path
		if since != "" {
			q += "?since=" + url.QueryEscape(since)
		}
		data, status, err := apiCallRaw("GET", q, nil)
		if err != nil || status != http.StatusOK {
			fmt.Fprintf(os.Stderr, "Error reading the health settings: %v %s\n", err, data)
			clierr.Exit1()
		}
		if asJSON {
			fmt.Println(string(data))
			return
		}
		var out struct {
			Keys []struct {
				Key     string `json:"key"`
				Value   any    `json:"value"`
				Default any    `json:"default"`
				Range   string `json:"range"`
			} `json:"keys"`
			Log []struct {
				At, Actor, Field, Old, New string
			} `json:"log"`
		}
		if json.Unmarshal(data, &out) != nil {
			fmt.Fprintln(os.Stderr, "Error: the server's answer was not the health settings")
			clierr.Exit1()
		}
		tw := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "KEY\tVALUE\tDEFAULT\tACCEPTS")
		for _, k := range out.Keys {
			fmt.Fprintf(tw, "%s\t%v\t%v\t%s\n", k.Key, k.Value, k.Default, k.Range)
		}
		tw.Flush()
		if since != "" {
			fmt.Printf("\n%d change(s) in the last %s\n", len(out.Log), since)
			for _, l := range out.Log {
				fmt.Printf("  %s %s %s: %s -> %s\n", l.At, l.Actor, strings.TrimPrefix(l.Field, "health."), l.Old, l.New)
			}
		}
	case "set", "reset":
		var key, value string
		switch {
		case args[0] == "set" && len(rest) >= 3 && rest[0] == "set":
			key, value = rest[1], strings.Join(rest[2:], " ")
		case args[0] == "reset" && len(rest) == 2 && rest[0] == "reset":
			key = rest[1]
		default:
			fmt.Fprintln(os.Stderr, healthUsageText)
			clierr.Exit1()
		}
		req := map[string]any{"key": key, "value": value}
		if args[0] == "reset" {
			req = map[string]any{"key": key, "reset": true}
		}
		data, status, err := apiCallRaw("PUT", path, req)
		if err != nil || status != http.StatusOK {
			fmt.Fprintf(os.Stderr, "Error: %v %s\n", err, data)
			clierr.Exit1()
		}
		var out struct {
			Changed []struct{ Key, Old, New string } `json:"changed"`
		}
		_ = json.Unmarshal(data, &out)
		if len(out.Changed) == 0 {
			fmt.Printf("%s is already %s: nothing changed\n", key, value)
			return
		}
		for _, c := range out.Changed {
			if c.Old == "" && c.New == "changed" {
				fmt.Printf("%s: changed\n", c.Key)
			} else {
				fmt.Printf("%s: %s -> %s\n", c.Key, c.Old, c.New)
			}
		}
	default:
		fmt.Fprintln(os.Stderr, healthUsageText)
		clierr.Exit1()
	}
}
