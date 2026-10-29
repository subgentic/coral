package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/machinelaunch"
)

// coral machine launch --provider digitalocean --token-file F --hub-key-file K [--name N] [--region R] [--size S] [--agents claude@x,codex@y] [--max-mode launch] [--coral-version V] [--yes]
//
// Makes a cloud machine that runs Coral and joins Coral Hub (#9974, the joint note with coral-hub). The provider token and the Coral Hub automation key each come from a file only (mode 0600; "-" reads
// standard input, for one of them): never from the command line or the environment, never printed, never sent anywhere but its own service, and the instance is told only a one-time credential that expires
// in five minutes. The machine joins Coral Hub as a pending machine: you approve it there. A machine made by a launch that fails or is interrupted is deleted again.
//
// Exit codes: 0 launched, 1 not launched (declined, or the provider or the Hub refused, or the machine did not come up), 2 a usage problem or a secret file that is not safe to read, 130 interrupted.
var (
	newMachineProvider = func(name, token string) (machinelaunch.Provider, error) {
		if name == "digitalocean" {
			return machinelaunch.NewDigitalOcean(token)
		}
		return nil, fmt.Errorf("unknown provider %q: digitalocean is the one this version knows", name)
	}
	newMachineHub = func(baseURL, key, terms string) machinelaunch.Minter {
		return &machinelaunch.HubClient{BaseURL: baseURL, Key: key, TermsVersion: terms}
	}
)

var agentEntry = regexp.MustCompile(`^((claude|codex|pi)@[A-Za-z0-9._-]{1,40}|agy@sha256:[0-9a-f]{64})$`)

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func machineUsage(w io.Writer) {
	fmt.Fprintln(w, "usage: coral machine launch --provider digitalocean --token-file <path|-> --hub-key-file <path|-> [--hub-url https://app.coralhub.dev]")
	fmt.Fprintln(w, "         [--name NAME] [--region nyc3] [--size s-2vcpu-4gb] [--image SLUG] [--ssh-key ID]... [--agents claude@VERSION,codex@VERSION,pi@VERSION,agy@sha256:HEX]")
	fmt.Fprintln(w, "         [--max-mode view|interact|launch (default view)] [--coral-version VERSION] [--allow-ssh-from ADDRESS] [--yes]")
}

func runMachine(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "launch" {
		machineUsage(stderr)
		return 2
	}
	fs := flag.NewFlagSet("coral machine launch", flag.ContinueOnError)
	fs.SetOutput(stderr)
	provider := fs.String("provider", "", "the cloud provider: digitalocean")
	tokenFile := fs.String("token-file", "", "file with the provider's API token (mode 0600), or - for standard input")
	keyFile := fs.String("hub-key-file", "", "file with your Coral Hub automation key (chk_..., mode 0600), or - for standard input")
	hubURL := fs.String("hub-url", config.TierDefaultCloudURL, "the Coral Hub origin (https)")
	name := fs.String("name", "", "the machine's name (default coral- and six random characters)")
	region := fs.String("region", "nyc3", "the provider's region slug")
	size := fs.String("size", "s-2vcpu-4gb", "the provider's size slug")
	image := fs.String("image", "", "the provider's image slug (default: the provider's Ubuntu LTS)")
	agents := fs.String("agents", "", "agent CLIs to install: claude, codex and pi, each pinned as NAME@VERSION; agy (Antigravity) only as agy@sha256:HEX, the SHA-256 of the installer script you checked")
	maxMode := fs.String("max-mode", "view", "the most Coral Hub may do on the machine: view (the default), interact or launch: interact and launch are asked for explicitly")
	coralVersion := fs.String("coral-version", "", "the Coral release to install (default: this binary's version)")
	yes := fs.Bool("yes", false, "go on without asking (the price is still printed)")
	sshFrom := fs.String("allow-ssh-from", "", "the address (or CIDR) the machine's SSH accepts while the launch sets it up (default: this computer's public address, found over HTTPS)")
	var sshKeys listFlag
	fs.Var(&sshKeys, "ssh-key", "a provider ssh key id or fingerprint to install (repeatable); none by default")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		machineUsage(stderr)
		return 2
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "coral machine launch: "+format+"\n", a...)
		return 2
	}
	if fs.NArg() != 0 {
		return fail("unexpected argument %q", fs.Arg(0))
	}
	if *provider == "" || *tokenFile == "" || *keyFile == "" {
		machineUsage(stderr)
		return 2
	}
	if *tokenFile == "-" && *keyFile == "-" {
		return fail("only one of --token-file and --hub-key-file can read standard input")
	}
	if *hubURL == "" {
		return fail("this build has no default Coral Hub: pass --hub-url")
	}
	if *maxMode != "view" && *maxMode != "interact" && *maxMode != "launch" {
		return fail("--max-mode must be view, interact or launch")
	}
	version := *coralVersion
	if version == "" {
		version = config.Version
	}
	if version == "" {
		return fail("this is a development build: say which Coral release to install with --coral-version")
	}
	var agentList []string
	if *agents != "" {
		for _, a := range strings.Split(*agents, ",") {
			a = strings.TrimSpace(a)
			if !agentEntry.MatchString(a) {
				return fail("--agents entry %q is not claude@VERSION, codex@VERSION, pi@VERSION or agy@sha256:HEX (nothing is installed unpinned)", a)
			}
			agentList = append(agentList, a)
		}
	}
	checkKeys, err := machinelaunch.NewBootKeys()
	if err != nil {
		return fail("%v", err)
	}
	checkSource := "203.0.113.1" // documentation address: only the other flags are being checked
	if *sshFrom != "" {
		v, verr := machinelaunch.ValidSSHSource(*sshFrom) // refused before any secret is read or any call is made
		if verr != nil {
			return fail("--allow-ssh-from: %v", verr)
		}
		checkSource, *sshFrom = v, v
	}
	_, err = machineUserData(checkKeys, checkSource, *maxMode, version, *hubURL, agentList) // the flags are checked by the builder before any secret is read or any call is made
	checkKeys.Destroy()
	if err != nil {
		return fail("%v", err)
	}
	machine := *name
	if machine == "" {
		var b [3]byte
		_, _ = rand.Read(b[:])
		machine = "coral-" + hex.EncodeToString(b[:])
	}

	token, err := machinelaunch.ReadSecretFile(*tokenFile, stdin)
	if err != nil {
		return fail("the provider token: %v", err)
	}
	key, err := machinelaunch.ReadSecretFile(*keyFile, stdin)
	if err != nil {
		return fail("the Coral Hub key: %v", err)
	}
	p, err := newMachineProvider(*provider, token)
	if err != nil {
		return fail("%v", err)
	}
	if *hubURL != config.TierDefaultCloudURL {
		fmt.Fprintf(stderr, "coral machine launch: warning: %s is not this build's Coral Hub (%s): the Hub key is sent there.\n", *hubURL, config.TierDefaultCloudURL)
	}
	hub := newMachineHub(*hubURL, key, license.EULAVersion)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	source := *sshFrom
	if source == "" {
		var derr error
		if source, derr = detectSSHSource(ctx); derr != nil {
			return fail("%v", derr)
		}
	}
	deps := machinelaunch.Deps{
		Provider: p, Hub: hub, Out: stdout, Bootstrap: newMachineBootstrap(),
		UserData: func(keys *machinelaunch.BootKeys) (string, error) {
			return machineUserData(keys, source, *maxMode, version, *hubURL, agentList)
		},
	}
	if f, ok := stdin.(*os.File); ok && isTerminal(f) && *tokenFile != "-" && *keyFile != "-" {
		deps.Confirm = func(summary string) (bool, error) {
			fmt.Fprintln(stdout, summary)
			fmt.Fprint(stdout, "Create it? [y/N] ")
			line, _ := bufio.NewReader(stdin).ReadString('\n')
			a := strings.ToLower(strings.TrimSpace(line))
			return a == "y" || a == "yes", nil
		}
	}

	_, err = machinelaunch.Launch(ctx, machinelaunch.Options{
		Name: machine, Region: *region, Size: *size, Image: *image, SSHKeys: sshKeys, Yes: *yes, HubURL: *hubURL, SSHFrom: source,
	}, deps)
	switch {
	case err == nil:
		return 0
	case ctx.Err() != nil:
		fmt.Fprintln(stderr, "coral machine launch: interrupted:", err)
		return 130
	default:
		fmt.Fprintln(stderr, "coral machine launch:", err)
		return 1
	}
}
