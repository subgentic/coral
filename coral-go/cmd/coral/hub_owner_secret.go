package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/internal/config"
	"golang.org/x/term"
)

// runHubOwnerSecret is `coral hub-owner-secret [--home DIR]` (#11378, gap A): the human act that installs the secret a self-hosted hub signs its owner stamps with. It is run by the hub's SSH session
// when it sets this computer up, or by a person at this computer's own command line; no HTTP route can do it, whatever key it is called with. The id the hub knows this computer by and the secret are JSON on
// STDIN, {"remote", "secret"} at most 1 KiB, no other field, never argv; at a terminal it asks for the hub's setup line instead (not echoed). It writes <data folder>/hub_owner_secret (0600) and replaces an earlier one: that is how the secret is rotated. It is not in the
// command list.
func runHubOwnerSecret(args []string, stdin io.Reader, stdout, stderr io.Writer, write func(dir, remote, secret string) error) int {
	return runHubOwnerSecretWith(args, stdin, stdout, stderr, write, hiddenLine)
}

// hiddenLine reads one line from the terminal without echoing it, or says there is no terminal (the command then reads JSON from stdin).
func hiddenLine(prompt string, stderr io.Writer) (string, bool, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", false, nil
	}
	fmt.Fprint(stderr, prompt)
	b, err := term.ReadPassword(fd)
	fmt.Fprintln(stderr)
	return string(b), true, err
}

// runHubOwnerSecretWith is the command with its terminal prompt injected. At a terminal it asks for the setup line the hub showed ("<id> <secret>", not echoed, so it is in no shell history or screen);
// anywhere else the id and the secret are JSON on stdin.
func runHubOwnerSecretWith(args []string, stdin io.Reader, stdout, stderr io.Writer, write func(dir, remote, secret string) error, ask func(prompt string, stderr io.Writer) (string, bool, error)) int {
	// This is the PERSON's act: run from an agent's session (its identity variables are in the environment) it refuses, whatever the agent was told to do.
	for _, v := range agentenv.IdentityVars {
		if os.Getenv(v) != "" {
			fmt.Fprintln(stderr, "coral hub-owner-secret: this is the person's act at this computer: it will not run inside an agent's session")
			return 1
		}
	}
	fs := flag.NewFlagSet("hub-owner-secret", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", "", "Coral's data folder, if the server was started with --home")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		fmt.Fprintln(stderr, "usage: coral hub-owner-secret [--home DIR]   (the id and the secret as JSON on stdin)")
		return 2
	}
	var in struct {
		Remote string `json:"remote"`
		Secret string `json:"secret"`
	}
	if line, tty, err := ask("Paste the setup line the hub showed (it is not shown as you type): ", stderr); err != nil {
		fmt.Fprintln(stderr, "coral hub-owner-secret: could not read the setup line")
		return 2
	} else if tty {
		f := strings.Fields(line)
		if len(f) != 2 || len(line) > 1024 {
			fmt.Fprintln(stderr, "coral hub-owner-secret: the setup line is the computer's name and the secret, with a space between")
			return 2
		}
		in.Remote, in.Secret = f[0], f[1]
	} else {
		data, err := io.ReadAll(io.LimitReader(stdin, 1025))
		if err != nil || len(data) > 1024 {
			fmt.Fprintln(stderr, "coral hub-owner-secret: stdin is missing or too long")
			return 2
		}
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil || dec.More() {
			fmt.Fprintln(stderr, "coral hub-owner-secret: stdin is not {remote, secret}")
			return 2
		}
	}
	if err := write(config.ResolveCoralDir(*home), in.Remote, in.Secret); err != nil {
		fmt.Fprintln(stderr, "coral hub-owner-secret: refused:", err)
		return 1
	}
	fmt.Fprintln(stdout, "the hub's owner stamp secret is installed")
	return 0
}
