package clihelp

import (
	"fmt"
	"io"
	"strings"
)

// An Area is one thing an agent does with Coral from a command line (#20399): "coral-board help overview" lists the areas in one screen, "coral-board help <area>" says what the area is for, its commands with
// one example each, the rules that matter, and where the long guide is. A tool keeps its areas in one table; a test fails when a command of its command table is in no area (or in two), or a "more:" guide
// does not exist in agent_docs, so the help cannot drift from the commands.
type Area struct {
	Name     string   // the word after "help"
	Summary  string   // one or two lines on the overview screen (kept short: the overview is one screen)
	What     string   // what the area is for, 2 or 3 lines on its page
	Commands []string // the top-level commands (of the tool's command table) this area covers; each is in exactly one area
	Examples []string // one example per line of the page: "command   # what it does"
	Rules    []string // the key rules
	More     []string // agent_docs topics ("coral-agent docs <topic>")
}

// Overview is the one screen: the areas, one line each ending with how to open its page, then the other tool's overview.
func Overview(tool, other string, areas []Area) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s help overview: what you can do with Coral from here\n\n", tool)
	width := 0
	for _, a := range areas {
		if len(a.Name) > width {
			width = len(a.Name)
		}
	}
	for _, a := range areas {
		fmt.Fprintf(&b, "  %-*s  %s  (%s help %s)\n", width, a.Name, a.Summary, tool, a.Name)
	}
	if other != "" {
		fmt.Fprintf(&b, "\n%s\n", other)
	}
	fmt.Fprintf(&b, "\nEvery page ends with 'more: %s docs <topic>', the long guide. All commands: %s help\n", "coral-agent", tool)
	return b.String()
}

// AreaPage is the page of one area.
func AreaPage(tool string, a Area) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s help %s\n\n%s\n", tool, a.Name, a.What)
	if len(a.Examples) > 0 {
		b.WriteString("\nCommands:\n")
		for _, e := range a.Examples {
			fmt.Fprintf(&b, "  %s\n", e)
		}
	}
	if len(a.Rules) > 0 {
		b.WriteString("\nRules:\n")
		for _, r := range a.Rules {
			fmt.Fprintf(&b, "  - %s\n", r)
		}
	}
	if len(a.More) > 0 {
		docs := make([]string, len(a.More))
		for i, m := range a.More {
			docs[i] = "coral-agent docs " + m
		}
		fmt.Fprintf(&b, "\nmore: %s\n", strings.Join(docs, "; "))
	}
	return b.String()
}

// HelpAreas answers "help overview" and "help <area>" for a tool's table; it reports whether name was one. A name that is also a command (health, search) gets the command's own usage after the area's page.
func HelpAreas(tool, other, name string, areas []Area, commandUsage func(string) string, w io.Writer) bool {
	if name == "overview" {
		fmt.Fprint(w, Overview(tool, other, areas))
		return true
	}
	for _, a := range areas {
		if a.Name != name {
			continue
		}
		fmt.Fprint(w, AreaPage(tool, a))
		if u := commandUsage(name); u != "" {
			fmt.Fprintf(w, "\nThe command itself:\n%s\n", u)
		}
		return true
	}
	return false
}
