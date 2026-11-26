package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/hooks"
)

// `coral cli-check [type]` (#21533): whether the Coral on this computer sees each agent CLI, for an install with no browser (a headless install, a setup script). It asks the same
// GET /api/system/cli-check the dashboard's New agent check asks, signed with Coral's command-line token (like `coral cloud status`), so it needs no API key and talks only to this computer.
//
// Exit codes: 0 done (every type is listed; with a type named, that CLI was found), 1 the named CLI is missing or the server refused, 2 a usage problem or an unknown type, 4 Coral isn't running here.
func runCLICheck(args []string, stdout, stderr io.Writer) int {
	usage := func() int {
		fmt.Fprintln(stderr, "usage: coral cli-check [type] [--url ...] [--home DIR]   (type: "+strings.Join(agent.CLITypes(), ", ")+"; with no type, every one is listed)")
		return 2
	}
	fs := flag.NewFlagSet("cli-check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	base := fs.String("url", hooks.CoralBase(), "the running Coral server, on this computer")
	home := fs.String("home", "", "Coral's data folder, if the server was started with --home (default: CORAL_DATA_DIR or ~/.coral)")
	// the type may come before or after the flags
	var types []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return usage()
		}
		rest = fs.Args()
		if len(rest) > 0 {
			types = append(types, rest[0])
			rest = rest[1:]
		}
	}
	if len(types) > 1 {
		return usage()
	}
	all := agent.CLITypes()
	named := ""
	if len(types) == 1 {
		named = strings.ToLower(types[0])
		if !slices.Contains(all, named) {
			fmt.Fprintf(stderr, "coral cli-check: %q is not an agent type Coral knows: %s\n", types[0], strings.Join(all, ", "))
			return 2
		}
		all = []string{named}
	}
	*base = runningServerURL(fs, *base, *home)
	server := strings.TrimRight(*base, "/")
	if !loopbackURL(server) {
		fmt.Fprintf(stderr, "coral cli-check: %s is not this computer: this command only talks to the Coral running here\n", server)
		return 2
	}
	token, err := cloud.ReadCLIToken(config.ResolveCoralDir(*home))
	if err != nil {
		fmt.Fprintf(stderr, "coral cli-check: could not read Coral's command-line token (%v): run this as the user Coral runs as, with Coral started (and --home if it uses one)\n", err)
		return 2
	}
	cli := cloud.CLIClient{Base: server, Token: token}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	missing := false
	for _, t := range all {
		r, code := cliCheckOne(ctx, cli, t, stderr)
		if code != 0 {
			return code
		}
		fmt.Fprintln(stdout, cliCheckLine(t, r))
		if !r.Found {
			missing = true
		}
	}
	if named != "" && missing {
		return 1
	}
	return 0
}

type cliCheckReply struct {
	Found     bool   `json:"found"`
	Supported *bool  `json:"supported"`
	Path      string `json:"path"`
	Version   string `json:"version"`
	Probe     string `json:"probe"`
	Message   string `json:"message"`
	Install   string `json:"install_command"`
	Refused   string `json:"refused"`
	Configure bool   `json:"configured"`
}

// cliCheckLine is one agent type's line: "claude  found  /usr/local/bin/claude  2.1.300", or why it is not found.
func cliCheckLine(t string, r cliCheckReply) string {
	pad := fmt.Sprintf("%-12s", t)
	switch {
	case r.Supported != nil && !*r.Supported:
		return pad + " not available here: " + r.Message
	case !r.Found && r.Refused != "":
		return pad + " not used: " + r.Refused
	case !r.Found && r.Configure:
		return pad + " not found: " + r.Message
	case !r.Found:
		line := pad + " not found"
		if r.Install != "" {
			line += " (install: " + r.Install + ")"
		}
		return line
	}
	line := pad + " found"
	if r.Path != "" {
		line += "  " + r.Path
	}
	if r.Version != "" {
		line += "  " + r.Version
	}
	if r.Probe != "" && r.Probe != "ok" {
		line += "  (running it did not work: " + r.Probe + ")"
	}
	return line
}

// cliCheckOne asks the server about one agent type; a non-zero code is the exit code (already reported).
func cliCheckOne(ctx context.Context, cli cloud.CLIClient, agentType string, stderr io.Writer) (cliCheckReply, int) {
	var out cliCheckReply
	resp, err := cli.Do(ctx, http.MethodGet, "/api/system/cli-check?type="+url.QueryEscape(agentType), nil, http.Header{}, 30*time.Second)
	switch {
	case errors.Is(err, cloud.ErrNotCoral):
		fmt.Fprintf(stderr, "coral cli-check: %s: %v. Nothing was sent.\n", cli.Base, err)
		return out, 4
	case ctx.Err() != nil:
		return out, 130
	case err != nil:
		fmt.Fprintf(stderr, "coral cli-check: Coral is not running at %s: start it and run this again\n", cli.Base)
		return out, 4
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		fmt.Fprintf(stderr, "coral cli-check: %s: %s\n", agentType, e.Error)
		return out, 1
	}
	if err := json.Unmarshal(data, &out); err != nil {
		fmt.Fprintln(stderr, "coral cli-check: unexpected answer from Coral")
		return out, 1
	}
	return out, 0
}
