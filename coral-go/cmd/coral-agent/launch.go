package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/hooks"
)

// cmdLaunch starts an agent through the server's launch API, so it gets the
// same defaults (agent type, model, permission mode) and shows up in the UI
// like one started from + New Agent.
func cmdLaunch(args []string) {
	var dir string
	var flagArgs []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flagArgs = append(flagArgs, args[i])
			if !strings.Contains(args[i], "=") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				flagArgs = append(flagArgs, args[i+1])
				i++
			}
		} else if dir == "" {
			dir = args[i]
		}
	}

	fs := flag.NewFlagSet("launch", flag.ContinueOnError)
	agentType := fs.String("type", "", "Agent type: claude, codex, agy, pi or terminal (default: your Coral setting)")
	name := fs.String("name", "", "Display name")
	model := fs.String("model", "", "Model (default: your Coral setting for the agent type)")
	prompt := fs.String("prompt", "", "Initial prompt")
	boardID := fs.String("board", "", "Join this board: its id (coral-board's state, or GET /api/board/projects)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: coral-agent launch [dir] [--type T] [--name N] [--model M] [--prompt P] [--board ID]`)
		fs.PrintDefaults()
	}
	clihelp.ParseFlags(fs, flagArgs, func() string { return commandUsage(os.Args[1], os.Args[2:]) })

	if dir == "" {
		dir = "."
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid directory %s: %v\n", dir, err)
		clierr.Exit1()
	}
	if info, err := os.Stat(absDir); err != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "Not a directory: %s\n", absDir)
		clierr.Exit1()
	}

	body := map[string]any{"working_dir": absDir}
	for key, val := range map[string]string{
		"agent_type": *agentType, "display_name": *name, "model": *model, "prompt": *prompt,
		"board_id": *boardID, // joins that existing board (#3536); never starts one
	} {
		if val != "" {
			body[key] = val
		}
	}

	// Launching checks the agent CLI and starts its session, which can take a
	// few seconds, so this call gets longer than the task calls.
	data, status, err := apiCall("POST", "/api/sessions/launch", body, 60*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	var result map[string]any
	json.Unmarshal(data, &result)
	if status != http.StatusOK {
		msg, _ := result["message"].(string)
		if msg == "" {
			msg, _ = result["error"].(string)
		}
		if msg == "" {
			msg = clierr.Describe(nil, status, data)
		}
		fmt.Fprintf(os.Stderr, "Error launching agent: %s\n", msg)
		clierr.Exit1()
	}

	// Older servers don't echo agent_type back.
	launchedType, _ := result["agent_type"].(string)
	if launchedType == "" {
		launchedType = *agentType
	}
	sessionName, _ := result["session_name"].(string)
	label := strings.TrimSpace(launchedType + " agent")
	if *name != "" {
		label = *name
		if launchedType != "" {
			label += " (" + launchedType + ")"
		}
	}
	fmt.Printf("Launched %s in %s\n", label, absDir)
	fmt.Printf("  Session: %s\n", sessionName)
	fmt.Printf("  Open Coral to work with it: %s\n", hooks.RedactedURL(serverURL))
}
