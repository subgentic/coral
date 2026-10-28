package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
)

// coral-board link / unlink / links (#9893): the Operator's way to say which of this computer's teams may message which. A link is an entry on the target team's list of who may message it;
// the default links both ways with files on, as the operator asked. The server refuses an agent token and Coral Hub: run these outside an agent's terminal. Until the Operator turns on
// "Require a link between teams on this computer" the links are recorded and counted but nothing is refused.

// linkArgs splits "<team> <other>" and the flags of link and unlink.
func linkArgs(args []string) (team, other string, oneWay, noFiles bool, err error) {
	var pos []string
	for _, a := range args {
		switch a {
		case "--one-way":
			oneWay = true
		case "--no-files":
			noFiles = true
		default:
			pos = append(pos, a)
		}
	}
	if len(pos) != 2 {
		return "", "", false, false, fmt.Errorf("a team and the other team are needed")
	}
	return pos[0], pos[1], oneWay, noFiles, nil
}

// errLinkUsage marks a mistake in how link or unlink was typed (exit 2), as against a refusal by the server (exit 1).
type errLinkUsage struct{ msg string }

func (e errLinkUsage) Error() string { return e.msg }

func cmdLink(unlink bool) {
	if err := runLink(unlink, os.Args[2:], os.Stdout); err != nil {
		var usage errLinkUsage
		if errors.As(err, &usage) {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			if u := commandUsage(os.Args[1], nil); u != "" {
				fmt.Fprintln(os.Stderr, u)
			}
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}

// runLink does link (or unlink) for args (the team, the other team and the flags) and writes what happened to out.
func runLink(unlink bool, args []string, out io.Writer) error {
	team, other, oneWay, noFiles, err := linkArgs(args)
	if err != nil {
		return errLinkUsage{err.Error()}
	}
	if unlink && noFiles {
		return errLinkUsage{"--no-files is for link: unlink removes the link whole"}
	}
	body := map[string]any{"with": other, "both": !oneWay}
	method := http.MethodPost
	if unlink {
		method = http.MethodDelete
	} else {
		body["files"] = !noFiles
	}
	result, status, err := apiCall(method, "/"+url.PathEscape(team)+"/cross-team-links", body)
	if err != nil {
		return err
	}
	if e := serverError(status, result); e != nil {
		return e
	}
	t, o := linkLabel(result["team"], team), other
	for _, x := range linkEnds(result["this_team_may_message"]) {
		if x.id == other || x.label == other {
			o = x.label
		}
	}
	files := "files on"
	if noFiles {
		files = "files off"
	}
	switch {
	case unlink && !oneWay:
		fmt.Fprintf(out, "Unlinked %s and %s: neither may message the other through a link.\n", t, o)
	case unlink:
		fmt.Fprintf(out, "%s may no longer message %s through a link.\n", t, o)
	case oneWay:
		fmt.Fprintf(out, "%s may now message %s (one way, %s).\n", t, o, files)
	default:
		fmt.Fprintf(out, "Linked %s and %s: each may message the other (%s).\n", t, o, files)
	}
	if enforced, _ := result["enforced"].(bool); !enforced {
		fmt.Fprintln(out, "Links are recorded but not required yet: teams on this computer can still message each other until \"Require a link between teams on this computer\" is turned on.")
	}
	return nil
}

func cmdLinks() {
	team := ""
	if len(os.Args) > 2 {
		team = os.Args[2]
	} else if st := loadState(); st != nil {
		team = st.Project
	}
	if team == "" {
		fmt.Fprintln(os.Stderr, "Error: name a team: coral-board links <team>")
		os.Exit(2)
	}
	if err := runLinks(team, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}

// runLinks writes a team's links to out.
func runLinks(team string, out io.Writer) error {
	result, status, err := apiCall(http.MethodGet, "/"+url.PathEscape(team)+"/cross-team-links", nil)
	if err != nil {
		return err
	}
	if e := serverError(status, result); e != nil {
		return e
	}
	fmt.Fprintf(out, "%s\n", linkLabel(result["team"], team))
	printLinkEnds(out, "  may message this team:", linkEnds(result["may_message_this_team"]))
	printLinkEnds(out, "  may be messaged by this team:", linkEnds(result["this_team_may_message"]))
	if n, _ := result["through_coral_hub"].(float64); n > 0 {
		fmt.Fprintf(out, "  %d more through Coral Hub (made and read there)\n", int(n))
	}
	if enforced, _ := result["enforced"].(bool); enforced {
		fmt.Fprintln(out, "  required: a team that is not linked is refused")
	} else {
		fmt.Fprintln(out, "  not required yet: links are recorded, nothing is refused")
	}
	return nil
}

type linkEnd struct {
	id, label string
	files     bool
}

func linkEnds(v any) []linkEnd {
	list, _ := v.([]any)
	var out []linkEnd
	for _, x := range list {
		m, _ := x.(map[string]any)
		l, _ := m["label"].(string)
		b, _ := m["board"].(string)
		f, _ := m["files"].(bool)
		out = append(out, linkEnd{id: b, label: clitext.CleanName(l), files: f})
	}
	return out
}

func linkLabel(v any, fallback string) string {
	if m, ok := v.(map[string]any); ok {
		if l, _ := m["label"].(string); l != "" {
			return clitext.CleanName(l)
		}
	}
	return fallback
}

func printLinkEnds(out io.Writer, heading string, ends []linkEnd) {
	if len(ends) == 0 {
		fmt.Fprintf(out, "%s none\n", heading)
		return
	}
	var parts []string
	for _, e := range ends {
		f := "files on"
		if !e.files {
			f = "files off"
		}
		parts = append(parts, fmt.Sprintf("%s (%s)", e.label, f))
	}
	fmt.Fprintf(out, "%s %s\n", heading, strings.Join(parts, ", "))
}
