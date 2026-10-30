package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/subgentic/coral/internal/config"
)

// runHubOwnerSecret is `coral hub-owner-secret [--home DIR]` (#11378, gap A): the human act that installs the secret a self-hosted hub signs its owner stamps with. It is run by the hub's SSH session
// when it sets this computer up, or by a person at this computer's own command line; no HTTP route can do it, whatever key it is called with. The id the hub knows this computer by and the secret are JSON on
// STDIN, {"remote", "secret"} at most 1 KiB, no other field, never argv. It writes <data folder>/hub_owner_secret (0600) and replaces an earlier one: that is how the secret is rotated. It is not in the
// command list.
func runHubOwnerSecret(args []string, stdin io.Reader, stdout, stderr io.Writer, write func(dir, remote, secret string) error) int {
	fs := flag.NewFlagSet("hub-owner-secret", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", "", "Coral's data folder, if the server was started with --home")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		fmt.Fprintln(stderr, "usage: coral hub-owner-secret [--home DIR]   (the id and the secret as JSON on stdin)")
		return 2
	}
	data, err := io.ReadAll(io.LimitReader(stdin, 1025))
	if err != nil || len(data) > 1024 {
		fmt.Fprintln(stderr, "coral hub-owner-secret: stdin is missing or too long")
		return 2
	}
	var in struct {
		Remote string `json:"remote"`
		Secret string `json:"secret"`
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || dec.More() {
		fmt.Fprintln(stderr, "coral hub-owner-secret: stdin is not {remote, secret}")
		return 2
	}
	if err := write(config.ResolveCoralDir(*home), in.Remote, in.Secret); err != nil {
		fmt.Fprintln(stderr, "coral hub-owner-secret: refused:", err)
		return 1
	}
	fmt.Fprintln(stdout, "the hub's owner stamp secret is installed")
	return 0
}
