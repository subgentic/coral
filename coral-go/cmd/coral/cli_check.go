package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/hooks"
)

// runCLICheck asks the running server, so its saved paths and environment decide
// what is installed, rather than the shell invoking this command.
func runCLICheck(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("cli-check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	base := fs.String("url", hooks.CoralBase(), "Coral server URL")
	home := fs.String("home", "", "Coral's data folder")
	var words []string
	for {
		if err := fs.Parse(args); err != nil {
			return 2
		}
		if fs.NArg() == 0 {
			break
		}
		words = append(words, fs.Arg(0))
		args = fs.Args()[1:]
	}
	types := agent.CLITypes()
	if len(words) > 1 || (len(words) == 1 && agent.GetCLIInfo(words[0]) == nil) {
		fmt.Fprintf(stderr, "usage: coral cli-check [type] [--url URL] [--home DIR]; types: %v\n", types)
		return 2
	}
	if len(words) == 1 {
		types = words
	}
	server, err := resolveServerURL(fs, *base, *home)
	if err != nil {
		fmt.Fprintln(stderr, "coral cli-check:", err)
		return 1
	}
	c, code := newCloudClient(server, *home, "cli-check", stderr)
	if c == nil {
		return code
	}
	for _, typ := range types {
		var r struct {
			Found   *bool  `json:"found"`
			Path    string `json:"path"`
			Version string `json:"version"`
			Binary  string `json:"binary"`
			Message string `json:"message"`
		}
		if code := c.call(context.Background(), http.MethodGet, "/api/system/cli-check?type="+url.QueryEscape(typ), nil, nil, 30*time.Second, &r); code >= 0 {
			return code
		}
		if r.Found == nil {
			fmt.Fprintln(stderr, "coral cli-check: Coral did not report whether", typ, "was found")
			return 1
		}
		status := "not found"
		if *r.Found {
			status = "found"
		}
		path, version := r.Path, r.Version
		if path == "" {
			path = r.Binary
		}
		if path == "" {
			path = "-"
		}
		if version == "" {
			version = "-"
		}
		fmt.Fprintf(stdout, "%s: %s; path: %s; version: %s\n", typ, status, oneLine(path), oneLine(version))
		if r.Message != "" {
			fmt.Fprintln(stdout, "  "+oneLine(r.Message))
		}
		if len(words) == 1 && !*r.Found {
			return 1
		}
	}
	return 0
}
