package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"net/http"
	"net/url"
	"os"
	"strconv"
)

func cmdTaskEdit(st *boardState, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board task edit N --title TEXT [--priority P] | --restore-version K")
		exitFn(2)
		return
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil || id < 1 {
		fmt.Fprintln(os.Stderr, "a positive task ID is required")
		exitFn(2)
		return
	}
	fs := flag.NewFlagSet("task-edit", flag.ContinueOnError)
	title := fs.String("title", "", "Replacement title")
	priority := fs.String("priority", "", "critical, high, medium or low")
	restore := fs.Int("restore-version", 0, "Copy an old text version as a new edit")
	base := fs.Int("base-version", 0, "Refuse if the task has changed since this version")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	invalidVersion := false
	fs.Visit(func(f *flag.Flag) {
		if (f.Name == "restore-version" && *restore < 1) || (f.Name == "base-version" && *base < 1) {
			invalidVersion = true
		}
	})
	if invalidVersion {
		fmt.Fprintln(os.Stderr, "versions must be positive")
		exitFn(2)
		return
	}
	body := map[string]any{"subscriber_id": resolveSubscriberID()}
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "title":
			body["title"] = flagText(*title, "task title")
		case "priority":
			body["priority"] = *priority
		}
	})
	if *restore > 0 {
		body["restore_version"] = *restore
	}
	if *base > 0 {
		body["base_version"] = *base
	}
	if len(body) == 1 || fs.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "give --title, --priority or --restore-version")
		exitFn(2)
		return
	}
	data, status, err := apiCallRaw("PATCH", fmt.Sprintf("/%s/tasks/%d", url.PathEscape(st.Project), id), body)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Task edit failed: "+clierr.Describe(err, status, data))
		exitFn(1)
		return
	}
	var task struct {
		Version int    `json:"version"`
		Title   string `json:"title"`
	}
	_ = json.Unmarshal(data, &task)
	fmt.Printf("Task #%d edited to v%d: %s\n", id, task.Version, task.Title)
}
func cmdTaskHistory(st *boardState, args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board task history N")
		exitFn(2)
		return
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil || id < 1 {
		fmt.Fprintln(os.Stderr, "a positive task ID is required")
		exitFn(2)
		return
	}
	data, status, err := apiCallRaw("GET", fmt.Sprintf("/%s/tasks/%d/history", url.PathEscape(st.Project), id), nil)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Task history failed: "+clierr.Describe(err, status, data))
		exitFn(1)
		return
	}
	var out any
	if json.Unmarshal(data, &out) != nil {
		fmt.Fprintln(os.Stderr, "Invalid task history")
		exitFn(1)
		return
	}
	pretty, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(pretty))
}
