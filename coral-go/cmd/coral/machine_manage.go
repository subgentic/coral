package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/machinelaunch"
)

// coral machine list|delete|prune (#10918, coral-hub's request 3). They talk to the provider with the same token file a launch uses and read the 0600 state file the launches write (ids only: no
// secret). `delete` revokes the machine's Hub identity first, with the automation key's destroy credential from --hub-destroy-file, then removes the instance, its firewall and its VPC; it can be
// run again. `prune` finds what a crashed or forgotten launch left, by this tool's tag and names, lists it and asks once. Nothing is torn down on a timer and no delete-capable token goes on a machine.
//
// Exit codes: 0 done, 1 something was not done (a refusal from the provider or the Hub, a declined confirm, a piece that could not be removed), 2 a usage problem or a secret file that is not safe to read, 130 interrupted.

// newMachineRevoker makes the Hub client a delete revokes through; a test replaces it.
var newMachineRevoker = func(baseURL, destroyKey string) machinelaunch.IdentityRevoker {
	return &machinelaunch.HubRevoker{BaseURL: baseURL, DestroyKey: destroyKey}
}

func machineManageUsage(w io.Writer) {
	fmt.Fprintln(w, "usage: coral machine list   --provider digitalocean --token-file <path|-> [--state-file PATH]")
	fmt.Fprintln(w, "       coral machine delete NAME --provider digitalocean --token-file <path|-> [--hub-destroy-file <path|->] [--hub-url https://app.coralhub.dev]")
	fmt.Fprintln(w, "         [--continue-if-revoke-fails] [--state-file PATH] [--yes]")
	fmt.Fprintln(w, "       coral machine prune --older-than 24h|7d --provider digitalocean --token-file <path|-> [--include-unknown] [--include-networks] [--state-file PATH] [--yes]")
	fmt.Fprintln(w, "       coral machine egress-files --dir DIR   (writes the machine's egress-block files, for tools/machine-egress-check.sh)")
}

// defaultMachineStatePath is the state file: machines.json in Coral's data folder (0700), which the launches write and these commands read.
func defaultMachineStatePath() string {
	return filepath.Join(config.ResolveCoralDir(""), "machines.json")
}

// tightenStateFolder makes the folder of the DEFAULT state file private (0700) when it already exists with looser permissions and is ours: the file is 0600 but a folder others can list tells them a machine
// was launched (#10944, Security's INFO). A folder the person chose with --state-file is left as it is (it may be a shared one): it is said, not changed.
func tightenStateFolder(path string, isDefault bool, warn io.Writer) {
	dir := filepath.Dir(path)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() || fi.Mode().Perm()&0o077 == 0 || runtime.GOOS == "windows" {
		return
	}
	if isDefault {
		if os.Chmod(dir, fi.Mode().Perm()&^0o077) == nil {
			return
		}
	}
	fmt.Fprintf(warn, "coral machine: warning: %s can be read by others (mode %o): the state file in it is private, but its name is not. Run chmod 700 on the folder.\n", dir, fi.Mode().Perm())
}

var olderThanRe = regexp.MustCompile(`^([0-9]{1,5})d$`)

// parseOlderThan reads 90m, 24h or 7d (a Go duration, or days).
func parseOlderThan(v string) (time.Duration, error) {
	if m := olderThanRe.FindStringSubmatch(v); m != nil {
		n, _ := strconv.Atoi(m[1])
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("--older-than %q is not a duration such as 90m, 24h or 7d", v)
	}
	return d, nil
}

func runMachineManage(sub string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if sub == "egress-files" {
		return runMachineEgressFiles(args, stdout, stderr)
	}
	fs := flag.NewFlagSet("coral machine "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	provider := fs.String("provider", "", "the cloud provider: digitalocean")
	tokenFile := fs.String("token-file", "", "file with the provider's API token (mode 0600), or - for standard input")
	statePath := fs.String("state-file", "", "the state file the launches write (default: machines.json in Coral's data folder)")
	yes := fs.Bool("yes", false, "go on without asking")
	var destroyFile, hubURL *string
	var continueRevoke, includeNetworks, includeUnknown *bool
	var olderThan *string
	switch sub {
	case "delete":
		destroyFile = fs.String("hub-destroy-file", "", "file with the automation key's destroy credential (chd_..., mode 0600), or -: revokes the machine's Coral Hub identity before the machine is destroyed")
		hubURL = fs.String("hub-url", config.TierDefaultCloudURL, "the Coral Hub origin (https)")
		continueRevoke = fs.Bool("continue-if-revoke-fails", false, "destroy the machine even if its Hub identity could not be revoked (it is still said, and it still has to be removed in Coral Hub)")
	case "prune":
		olderThan = fs.String("older-than", "", "how old an instance must be to count as an orphan: 90m, 24h or 7d (required)")
		includeUnknown = fs.Bool("include-unknown", false, "also take instances with this tool's tag that the state file does not know (they may belong to another computer or a lost state file: by default they are only counted)")
		includeNetworks = fs.Bool("include-networks", false, "also take private networks and firewalls with this tool's names that have no instance and no record (they carry no age)")
	}
	// flags and the machine name may come in either order: the name is the one argument that is not a flag
	var name string
	rest := args
	for {
		if err := fs.Parse(rest); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return 0
			}
			machineManageUsage(stderr)
			return 2
		}
		if fs.NArg() == 0 {
			break
		}
		if sub != "delete" || name != "" {
			fmt.Fprintf(stderr, "coral machine %s: unexpected argument %q\n", sub, fs.Arg(0))
			return 2
		}
		name, rest = fs.Arg(0), fs.Args()[1:]
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "coral machine "+sub+": "+format+"\n", a...)
		return 2
	}
	if *provider == "" || *tokenFile == "" || (sub == "delete" && name == "") {
		machineManageUsage(stderr)
		return 2
	}
	var age time.Duration
	if sub == "prune" {
		var err error
		if *olderThan == "" {
			return fail("--older-than is needed: how old an instance must be before it counts as an orphan")
		}
		if age, err = parseOlderThan(*olderThan); err != nil {
			return fail("%v", err)
		}
	}
	if sub == "delete" && *destroyFile == "-" && *tokenFile == "-" {
		return fail("only one of --token-file and --hub-destroy-file can read standard input")
	}
	path := *statePath
	if path == "" {
		path = defaultMachineStatePath()
	}
	tightenStateFolder(path, *statePath == "", stderr)
	st, err := machinelaunch.OpenState(path)
	if err != nil {
		return fail("%v", err)
	}
	token, err := machinelaunch.ReadSecretFile(*tokenFile, stdin)
	if err != nil {
		return fail("the provider token: %v", err)
	}
	var revoker machinelaunch.IdentityRevoker
	if sub == "delete" && *destroyFile != "" {
		destroyKey, err := machinelaunch.ReadSecretFile(*destroyFile, stdin)
		if err != nil {
			return fail("the Coral Hub destroy credential: %v", err)
		}
		revoker = newMachineRevoker(*hubURL, destroyKey)
	}
	p, err := newMachineProvider(*provider, token)
	if err != nil {
		return fail("%v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	d := machinelaunch.ManageDeps{Provider: p, Revoker: revoker, State: st, Out: stdout}
	if continueRevoke != nil {
		d.ContinueIfRevokeFails = *continueRevoke
	}
	if *yes {
		d.Confirm = func(string) (bool, error) { return true, nil }
	} else if f, ok := stdin.(*os.File); ok && isTerminal(f) && *tokenFile != "-" && (destroyFile == nil || *destroyFile != "-") {
		d.Confirm = func(summary string) (bool, error) {
			fmt.Fprintln(stdout, summary)
			fmt.Fprint(stdout, "Go on? [y/N] ")
			line, _ := bufio.NewReader(stdin).ReadString('\n')
			a := strings.ToLower(strings.TrimSpace(line))
			return a == "y" || a == "yes", nil
		}
	}
	finish := func(err error) int {
		switch {
		case err == nil:
			return 0
		case ctx.Err() != nil:
			fmt.Fprintln(stderr, "coral machine "+sub+": interrupted:", err)
			return 130
		default:
			fmt.Fprintln(stderr, "coral machine "+sub+":", err)
			return 1
		}
	}

	switch sub {
	case "list":
		rows, err := machinelaunch.List(ctx, d)
		if err != nil {
			return finish(err)
		}
		if len(rows) == 0 {
			fmt.Fprintln(stdout, "No machines made by this tool.")
			return 0
		}
		tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "NAME\tID\tSTATE\tREGION\tSIZE\tAGE\t$/HOUR\tRECORD")
		for _, r := range rows {
			state, price, rec := string(r.Status), "-", "no state file entry: delete finds it by name"
			if r.Gone {
				state = "gone at the provider"
			}
			if r.HourlyUSD > 0 {
				price = fmt.Sprintf("%.4f", r.HourlyUSD)
			}
			if r.InState {
				rec = "ids kept"
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.Name, orDash(r.ID), orDash(state), orDash(r.Region), orDash(r.Size), machinelaunch.AgeText(r.Age), price, rec)
		}
		_ = tw.Flush()
		return 0
	case "delete":
		if d.Confirm == nil {
			return fail("no one can be asked to confirm: pass --yes to go on without asking")
		}
		summary := fmt.Sprintf("Delete machine %q at %s: its instance, firewall and private network, and the state file's record. It cannot be undone.", name, p.Name())
		if rec, ok := st.Get(name); !ok {
			summary += " The state file does not know it: it is found at the provider by its name and this tool's tag."
		} else if rec.CredentialID != "" && revoker != nil {
			summary += " Its Coral Hub identity is revoked first."
		}
		if revoker == nil {
			summary += " No destroy credential was given (--hub-destroy-file): its Coral Hub identity is NOT revoked, and has to be removed in Coral Hub."
		}
		ok, err := d.Confirm(summary)
		if err != nil {
			return finish(err)
		}
		if !ok {
			fmt.Fprintln(stderr, "coral machine delete: not confirmed: nothing was deleted")
			return 1
		}
		rep, err := machinelaunch.Delete(ctx, name, d)
		if err == nil {
			fmt.Fprintf(stdout, "Deleted %s.\n", rep.Name)
		}
		return finish(err)
	case "prune":
		if d.Confirm == nil {
			return fail("no one can be asked to confirm: pass --yes to go on without asking")
		}
		rep, err := machinelaunch.Prune(ctx, machinelaunch.PruneOptions{OlderThan: age, IncludeUnknown: *includeUnknown, IncludeNetworks: *includeNetworks}, d)
		if err == nil && rep != nil && len(rep.Removed) > 0 {
			fmt.Fprintf(stdout, "Removed: %s.\n", strings.Join(rep.Removed, ", "))
		}
		if errors.Is(err, machinelaunch.ErrDeclined) {
			fmt.Fprintln(stderr, "coral machine prune: not confirmed: nothing was removed")
			return 1
		}
		return finish(err)
	}
	machineManageUsage(stderr)
	return 2
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// coral machine egress-files --dir DIR writes the egress block's three files (the nftables rules, the systemd unit, the check script) to DIR, as the user-data puts them on a machine. It makes no call to any
// provider and needs no secret: tools/machine-egress-check.sh uses them to check the block on a real machine, as a non-root user and as root, and after a reboot.
func runMachineEgressFiles(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("coral machine egress-files", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", "", "the folder to write the files to (made 0700 if it does not exist)")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *dir == "" {
		fmt.Fprintln(stderr, "usage: coral machine egress-files --dir DIR")
		return 2
	}
	if err := os.MkdirAll(*dir, 0o700); err != nil {
		fmt.Fprintf(stderr, "coral machine egress-files: %v\n", err)
		return 1
	}
	for _, f := range machinelaunch.EgressFiles() {
		mode, _ := strconv.ParseUint(f.Mode, 8, 32)
		path := filepath.Join(*dir, filepath.Base(f.Path))
		if err := os.WriteFile(path, []byte(f.Content), os.FileMode(mode)); err != nil {
			fmt.Fprintf(stderr, "coral machine egress-files: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "%s -> %s (put it at %s)\n", filepath.Base(f.Path), path, f.Path)
	}
	return 0
}
