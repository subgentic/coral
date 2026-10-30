package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/subgentic/coral/internal/config"
)

// runningServerURL is where a command reaches this computer's Coral (#235). --url, CORAL_URL and CORAL_PORT say so when given;
// otherwise the address the server for the data folder (--home, else CORAL_DATA_DIR or ~/.coral) recorded in its lock file, so a
// Coral started on another port is found; and only then base, the platform's default port.
func runningServerURL(fs *flag.FlagSet, base, home string) string {
	u, err := resolveServerURL(fs, base, home)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return u
}

// resolveServerURL is runningServerURL with the failure returned: a record whose process runs but whose address does not answer as that Coral is an error (the default
// port is not tried), and with no record the default (base) is used; the commands prove the server (CLI token hello) before they send a credential, so the default is not asked here.
func resolveServerURL(fs *flag.FlagSet, base, home string) (string, error) {
	given := false
	fs.Visit(func(f *flag.Flag) { given = given || f.Name == "url" })
	if given || os.Getenv("CORAL_URL") != "" || os.Getenv("CORAL_PORT") != "" {
		return base, nil
	}
	addr, err := config.ResolveRecorded(config.ResolveCoralDir(home))
	if err != nil {
		return "", err
	}
	if addr == "" {
		addr = base // the default is not asked here: these commands prove the server themselves before they send a credential (the CLI token hello)
	}
	return addr, err
}
