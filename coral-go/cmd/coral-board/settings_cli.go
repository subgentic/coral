package main

import (
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/subgentic/coral/internal/clierr"
)

// coral-board settings set <key> <value> (#11450): the Operator's way to write one Coral setting without pasting code into a browser console. The route is PUT /api/settings, which refuses an agent
// token, Coral Hub and a sign-in link, so an agent's terminal cannot use it; the server checks the key and the value against the registry and answers with its own words.

func cmdSettings() {
	if err := runSettings(os.Args[2:], os.Stdout); err != nil {
		if _, usage := err.(errLinkUsage); usage {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			if u := commandUsage(os.Args[1], nil); u != "" {
				fmt.Fprintln(os.Stderr, u)
			}
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}

// runSettings does "settings set <key> <value>" and writes what happened to out.
func runSettings(args []string, out io.Writer) error {
	if len(args) != 3 || args[0] != "set" {
		return errLinkUsage{"settings set <key> <value> is the only form"}
	}
	key, value := args[1], args[2]
	data, status, err := apiCallRawAt("/api", http.MethodPut, "/settings", map[string]any{key: value}, 10*1e9)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("not saved (HTTP %d): %s", status, trimReply(data))
	}
	fmt.Fprintf(out, "Saved %s.\n", key)
	return nil
}

// trimReply is a server's refusal as one short line.
func trimReply(b []byte) string {
	s := string(b)
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	return s
}
