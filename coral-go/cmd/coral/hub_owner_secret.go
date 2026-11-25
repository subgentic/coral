package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/pkg/hubowner"
	"golang.org/x/term"
)

// runHubOwnerSecret is `coral hub-owner-secret [--home DIR]` (#11378, gap A): the human act that installs the secret a self-hosted hub signs its owner stamps with. It is run by the hub's SSH session
// when it sets this computer up, or by a person at this computer's own command line; no HTTP route can do it, whatever key it is called with. The id the hub knows this computer by and the secret are JSON on
// STDIN, {"remote", "secret"} at most 1 KiB, no other field, never argv; at a terminal it asks for the hub's setup line instead (not echoed). It writes <data folder>/hub_owner_secret (0600) and replaces an earlier one: that is how the secret is rotated. It is not in the
// command list.
func runHubOwnerSecret(args []string, stdin io.Reader, stdout, stderr io.Writer, write func(dir string, l hubowner.Link) error) int {
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
func runHubOwnerSecretWith(args []string, stdin io.Reader, stdout, stderr io.Writer, write func(dir string, l hubowner.Link) error, ask func(prompt string, stderr io.Writer) (string, bool, error)) int {
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
	list := fs.Bool("list", false, "list the hubs this computer holds a secret for (never the secrets)")
	remove := fs.String("remove", "", "remove the secret of one hub: its hub id, or the computer id of an older hub's")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 || *list && *remove != "" {
		fmt.Fprintln(stderr, "usage: coral hub-owner-secret [--home DIR] [--list | --remove ID]   (to install: the id and the secret as JSON on stdin)")
		return 2
	}
	dir := config.ResolveCoralDir(*home)
	if *list {
		return listHubOwnerLinks(dir, stdout, stderr)
	}
	if *remove != "" {
		n, err := hubowner.Remove(dir, *remove)
		if err != nil {
			fmt.Fprintln(stderr, "coral hub-owner-secret: could not remove it:", err)
			return 1
		}
		if n == 0 {
			fmt.Fprintln(stderr, "coral hub-owner-secret: this computer holds no hub secret under that id (see --list)")
			return 1
		}
		fmt.Fprintln(stdout, "that hub's owner stamp secret is removed: its Approve through the hub is refused until it is set up again")
		return 0
	}
	// hub and name are the installing hub's link id and its name (#21213): a hub that sends them keeps its own secret here beside other hubs'; without them it is an older hub's single secret.
	var in struct {
		Remote string `json:"remote"`
		Secret string `json:"secret"`
		Hub    string `json:"hub"`
		Name   string `json:"name"`
	}
	if line, tty, err := ask("Paste the setup line the hub showed (it is not shown as you type): ", stderr); err != nil {
		fmt.Fprintln(stderr, "coral hub-owner-secret: could not read the setup line")
		return 2
	} else if tty {
		f := strings.Fields(line)
		if len(f) < 2 || len(f) > 3 || len(f) == 3 && !hubowner.ValidHubID(f[2]) || len(line) > 1024 {
			fmt.Fprintln(stderr, "coral hub-owner-secret: the setup line is the computer's name and the secret (and the hub's id, from a newer hub), with spaces between")
			return 2
		}
		in.Remote, in.Secret = f[0], f[1]
		if len(f) == 3 {
			in.Hub = f[2]
		}
	} else {
		data, err := io.ReadAll(io.LimitReader(stdin, 1025))
		if err != nil || len(data) > 1024 {
			fmt.Fprintln(stderr, "coral hub-owner-secret: stdin is missing or too long")
			return 2
		}
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil || dec.More() {
			fmt.Fprintln(stderr, "coral hub-owner-secret: stdin is not {remote, secret, hub, name}")
			return 2
		}
	}
	if in.Hub != "" && !hubowner.ValidHubID(in.Hub) {
		fmt.Fprintln(stderr, "coral hub-owner-secret: the hub's id is not valid")
		return 2
	}
	if err := write(dir, hubowner.Link{Hub: in.Hub, Name: in.Name, Remote: in.Remote, Secret: in.Secret}); err != nil {
		fmt.Fprintln(stderr, "coral hub-owner-secret: refused:", err)
		return 1
	}
	fmt.Fprintln(stdout, "the hub's owner stamp secret is installed")
	return 0
}

// listHubOwnerLinks prints the hubs this computer holds an owner stamp secret for: name, hub id, the computer's id at that hub and when it was installed. Never a secret.
func listHubOwnerLinks(dir string, stdout, stderr io.Writer) int {
	links, err := hubowner.Links(dir)
	if err != nil {
		fmt.Fprintln(stderr, "coral hub-owner-secret: the hubs' secrets could not be read:", err)
		return 1
	}
	if len(links) == 0 {
		fmt.Fprintln(stdout, "no hub's owner stamp secret is installed")
		return 0
	}
	left, isLeft := hubowner.Leftover(dir)
	for _, l := range links {
		hub := l.Hub
		if hub == "" {
			hub = "(an older hub, no id)"
		}
		fmt.Fprintf(stdout, "%s\thub %s\tthis computer at it: %s\tinstalled %s", l.Label(), hub, l.Remote, l.At)
		if isLeft && l.Hub == "" && l.Remote == left.Remote {
			fmt.Fprint(stdout, "\t"+hubowner.LeftoverNote(left))
		}
		fmt.Fprintln(stdout)
	}
	return 0
}

// installHubOwnerLink is the writer the command uses: the link goes beside other hubs' (hubowner.Install).
func installHubOwnerLink(dir string, l hubowner.Link) error {
	return hubowner.Install(dir, l, time.Now())
}
