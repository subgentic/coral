package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

// coral-board ask close <message-id> --note "answered in ..." (#11417): a question (post --ask) the Operator answered somewhere the board did not see, in chat or in an artifact comment. Only their own reply
// on the board closed one, so the board still counted it open and the health check repeated it. The asker, the Operator or the board's orchestrator closes it, and the note says where it was answered.

const askUsageText = `Usage: coral-board ask close <message-id> --note "where it was answered" [--board <project>]

  close   Close a question (post --ask) that was answered somewhere the board did not see (chat, an artifact comment). Nobody owes an answer afterwards and the
          health check stops repeating it. The asker, the Operator or the board's orchestrator may close it; the note is shown with the question.`

func cmdAsk() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, askUsageText)
		clierr.Exit1()
	}
	sub, args := os.Args[2], os.Args[3:]
	if sub == "--help" || sub == "-h" || sub == "help" {
		fmt.Println(askUsageText)
		os.Exit(0)
	}
	if sub != "close" {
		fmt.Fprintf(os.Stderr, "Unknown ask command %q.\n%s\n", sub, askUsageText)
		clierr.Exit1()
	}
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, askUsageText)
		clierr.Exit1()
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(args[0], "#"), 10, 64)
	if err != nil || id <= 0 {
		fmt.Fprintf(os.Stderr, "Error: %q is not a message id.\n%s\n", args[0], askUsageText)
		clierr.Exit1()
	}
	fs := flag.NewFlagSet("ask-close", flag.ContinueOnError)
	note := fs.String("note", "", "Where it was answered")
	board := fs.String("board", "", "The board (default: the one you joined)")
	clihelp.ParseFlags(fs, args[1:], func() string { return askUsageText })
	*note = flagText(*note, "close note")
	if strings.TrimSpace(*note) == "" {
		fmt.Fprintf(os.Stderr, "A note is required: say where it was answered.\n%s\n", askUsageText)
		clierr.Exit1()
	}
	project := strings.TrimSpace(*board)
	if project == "" {
		st := loadState()
		if st == nil {
			fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role> or give --board <project>")
			clierr.Exit1()
		}
		project = st.Project
	}
	path := fmt.Sprintf("/%s/asks/%d/close", url.PathEscape(project), id)
	goalCall("POST", path, map[string]any{"subscriber_id": resolveSubscriberID(), "note": *note}, "closing the question", 200)
	fmt.Printf("Closed the question in message #%d.\n", id)
}
