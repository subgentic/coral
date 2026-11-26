package main

import (
	"flag"
	"fmt"
	"io"
	"log"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/config"
)

// applyHubOnly turns hub-only mode on for this run when --hub-only, CORAL_HUB_ONLY=1 or the saved marker asks for it (#21558). Coral then listens on this computer only: a --host or --remote
// that would open the network is refused. --hub-only is saved, so a later start without it stays hub-only until `coral hub-only off` (run on this computer).
func applyHubOnly(cfg *config.Config, sf *serverFlags) error {
	asked := *sf.hubOnly
	saved := auth.HubOnlyPersisted(cfg.CoralDir())
	if !asked && !saved {
		return nil
	}
	if !config.IsLoopbackHost(cfg.Host) {
		return fmt.Errorf("--host %q is not allowed in hub-only mode: Coral listens on 127.0.0.1 only and is reached through Coral Hub. To open the network instead, run: coral hub-only off", cfg.Host)
	}
	if *sf.remoteAccess {
		return fmt.Errorf("--remote is not allowed in hub-only mode: Coral listens on 127.0.0.1 only and is reached through Coral Hub. To open the network instead, run: coral hub-only off")
	}
	if asked && !saved {
		if err := auth.SetHubOnlyPersisted(cfg.CoralDir(), true); err != nil {
			log.Printf("[hub-only] could not save hub-only, so a start without --hub-only will not be hub-only: %v", err)
		}
	}
	auth.SetHubOnly(true)
	log.Printf("[hub-only] on: Coral listens on 127.0.0.1 only, asks for a credential on this computer too, and refuses any proxied request. Reach it through Coral Hub. Turn it off with: coral hub-only off")
	return nil
}

// runHubOnly is `coral hub-only [on|off|status]`: the saved choice, changed from this computer only (it writes a file in the data folder; nothing over the network can).
func runHubOnly(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("hub-only", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", "", "Coral's data folder, if the server was started with --home")
	usage := func() int {
		fmt.Fprintln(stderr, "usage: coral hub-only [on|off|status] [--home DIR]   (takes effect at the next start)")
		return 2
	}
	word := "status"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		word, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		return usage()
	}
	dir := config.ResolveCoralDir(*home)
	switch word {
	case "status":
		if auth.HubOnlyPersisted(dir) {
			fmt.Fprintln(stdout, "Hub-only is on: Coral listens on 127.0.0.1 only and is reached through Coral Hub. Turn it off with: coral hub-only off")
		} else {
			fmt.Fprintln(stdout, "Hub-only is off. Turn it on with: coral hub-only on (or start Coral with --hub-only)")
		}
		return 0
	case "on", "off":
		if err := auth.SetHubOnlyPersisted(dir, word == "on"); err != nil {
			fmt.Fprintf(stderr, "coral hub-only: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "Hub-only is %s. Restart Coral to apply it.\n", word)
		return 0
	}
	return usage()
}
