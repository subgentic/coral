package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clihelp"
)

// Commands whose options are all known and which take no free text: a misspelt or unknown option is refused (exit 2, with the usage line)
// instead of being ignored. "task list --json" used to print a table and a script took it for JSON.
var (
	jsonOnly = clihelp.FlagSpec{Bools: []string{"--json"}}
	noFlags  = clihelp.FlagSpec{}
)

// checkKnownFlags checks args (os.Args[1:], --raw already taken out) against the table for its command and subcommand. A command that is
// not in the table is not checked here.
func checkKnownFlags(args []string) error {
	if len(args) == 0 {
		return nil
	}
	cmd, rest := args[0], args[1:]
	var spec clihelp.FlagSpec
	switch cmd {
	case "read":
		spec = clihelp.FlagSpec{Bools: []string{"--all", "-a", "--json"}, Values: []string{"--id", "--last"}}
	case "check":
		spec = clihelp.FlagSpec{Bools: []string{"--quiet"}}
	case "projects", "subscribers", "leave", "delete", "targets":
		spec = noFlags
	case "link":
		spec = clihelp.FlagSpec{Bools: []string{"--one-way", "--no-files"}, Positional: 2}
	case "unlink":
		spec = clihelp.FlagSpec{Bools: []string{"--one-way"}, Positional: 2}
	case "links":
		spec = clihelp.FlagSpec{Positional: 1}
	case "status":
		spec = clihelp.FlagSpec{Bools: []string{"--activity", "--json"}, Values: []string{"--board"}}
	case "queue":
		spec = jsonOnly
	case "goal":
		if len(rest) == 0 {
			return nil
		}
		sub := rest[0]
		rest = rest[1:]
		switch sub {
		case "list":
			spec = clihelp.FlagSpec{Bools: []string{"--json"}, Values: []string{"--state"}}
		case "show":
			spec = clihelp.FlagSpec{Bools: []string{"--json"}, Positional: 1}
		case "brief":
			spec = clihelp.FlagSpec{Bools: []string{"--json"}, Positional: 2} // "goal #65" may arrive as two words
		case "add":
			spec = clihelp.FlagSpec{Values: []string{"--outcome", "--done-when", "--state", "--driver"}, Positional: 1}
		case "update":
			spec = clihelp.FlagSpec{Values: []string{"--title", "--outcome", "--done-when", "--state", "--driver", "--blocked-on"}, Positional: 1}
		case "close":
			spec = clihelp.FlagSpec{Values: []string{"--reason", "--state"}, Positional: 1}
		case "request":
			spec = clihelp.FlagSpec{Values: []string{"--to", "--ask"}, Positional: 1}
		case "requests":
			spec = clihelp.FlagSpec{Bools: []string{"--json"}, Values: []string{"--status"}}
		case "request-decline":
			spec = clihelp.FlagSpec{Values: []string{"--reason"}, Positional: 1}
		default:
			return nil
		}
	case "task":
		if len(rest) == 0 {
			return nil
		}
		sub := rest[0]
		rest = rest[1:]
		switch sub {
		case "list":
			spec = clihelp.FlagSpec{Bools: []string{"--json"}, Values: []string{"--goal"}}
		case "current":
			spec = jsonOnly
		case "goal":
			spec = clihelp.FlagSpec{Positional: 2}
		case "detail", "show":
			spec = clihelp.FlagSpec{Bools: []string{"--json"}, Positional: 1}
		default:
			return nil
		}
	default:
		return nil
	}
	if err := clihelp.CheckFlags(rest, spec); err != nil {
		return err
	}
	if cmd == "read" {
		return checkReadNumbers(rest)
	}
	return nil
}

// checkReadNumbers refuses a read's --id or --last that is not a whole number from 1 up (0, a negative, a word or a number too big for an int
// all used to be read as "not given", so --last abc asked for no limit and --id abc read the unread list).
func checkReadNumbers(args []string) error {
	for i, a := range args {
		name, value, inline := strings.Cut(a, "=")
		if name != "--id" && name != "--last" {
			continue
		}
		if !inline {
			if i+1 >= len(args) {
				continue
			}
			value = args[i+1]
		}
		if n, err := strconv.Atoi(value); err != nil || n < 1 {
			return fmt.Errorf("%s needs a whole number, 1 or more (got %q)", name, value)
		}
	}
	return nil
}
