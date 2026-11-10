package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/updater/push"
	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/verify"
)

// push, receive and relaunch are the update of a Coral that has no internet (#15379): this computer downloads and verifies the release, `push` sends it over the operator's own ssh,
// and the remote's own coral-update installs it, verifying it again with its compiled-in pins (the sender's checks are not what the remote trusts).
//
//	coral-update push [--yes] [--stage-only] [--coral-update /abs/path] [--remote-port N] <ssh-host>
//	coral-update receive --probe | --version X.Y.Z      (the remote side; reads the stream on stdin)
//	coral-update relaunch [--check]                      (the remote side; relaunch.go)
const pushUsage = "usage: coral-update push [--yes] [--stage-only] [--coral-update /absolute/path] [--remote-port N] <ssh-host>"

func printJSON(w io.Writer, v any) { _ = json.NewEncoder(w).Encode(v) }

// runReceive is the remote side of a push: it reads the stream into <data>/updates/staging/<version>. It changes nothing else, and takes the check lock so a check does not prune the staging folder under it.
func runReceive(args []string, stdin io.Reader, stdout io.Writer, getenv func(string) string) int {
	if len(args) == 1 && args[0] == "--probe" {
		printJSON(stdout, map[string]int{"receive": 1})
		return 0
	}
	bad := func(reason string) int {
		printJSON(stdout, map[string]string{"result": "failed", "reason": reason})
		return 1
	}
	if len(args) != 2 || args[0] != "--version" || !push.PlainVersion(args[1]) {
		fmt.Fprintln(os.Stderr, "usage: coral-update receive --probe | --version X.Y.Z")
		return 2
	}
	if getenv("CORAL_AUTO_UPDATE") == "off" || config.Version == "" {
		printJSON(stdout, map[string]string{"result": "off"})
		return 1
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return bad("unsupported_platform")
	}
	dataDir := config.ResolveCoralDir("")
	updates := filepath.Join(dataDir, stage.UpdatesDir)
	if err := verify.EnsureDir(updates); err != nil {
		return bad("updates_folder")
	}
	release, err := stage.TakeLock(updates, stage.CheckLockFile, time.Now())
	if err != nil {
		return bad("busy")
	}
	defer release()
	version := args[1]
	if err := push.Receive(stdin, filepath.Join(updates, stage.StagingDir), version, assetName(runtime.GOOS, runtime.GOARCH, false)(version), stage.DefaultMaxPackage); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return bad("stream")
	}
	// The updater's own record of what is staged (as a check writes it), so Settings and the relaunch see it.
	st, _ := verify.LoadState(updates)
	st.Stage = &verify.StageState{Staged: version, StagedAt: time.Now().UTC().Format(time.RFC3339)}
	_ = verify.SaveState(updates, st)
	printJSON(stdout, map[string]string{"result": "received", "version": version})
	return 0
}

// localStage is the sender's staging step: the check, run for the REMOTE's installed version and package, in a private scratch folder, so this computer's own staged update and state are never touched.
func localStage(ctx context.Context, installed string, asset func(string) string) (push.Staged, string, string, func(), error) {
	scratch, err := os.MkdirTemp("", "coral-push-*") // 0700
	if err != nil {
		return push.Staged{}, "failed", "scratch", nil, err
	}
	cleanup := func() { os.RemoveAll(scratch) }
	trust, _, err := verify.LoadTrust(ctx, filepath.Join(config.ResolveCoralDir(""), stage.UpdatesDir, "tuf"))
	if err != nil {
		return push.Staged{}, "failed", "trusted_root", cleanup, err
	}
	res := stage.Check(ctx, stage.Config{
		DataDir:   scratch,
		Installed: installed,
		Pins:      verify.DefaultPins(),
		Verifier:  verify.Sigstore{Trust: trust},
		Fetcher:   &verify.Fetcher{Client: newClient()},
		Asset:     asset,
	})
	switch res.Result {
	case stage.ResultStaged, stage.ResultAlreadyStaged:
		s, err := stage.LoadStaged(scratch)
		if err != nil {
			return push.Staged{}, "failed", "staged", cleanup, err
		}
		return push.Staged{Version: s.Version, Dir: s.Dir}, "", "", cleanup, nil
	case stage.ResultUpToDate:
		return push.Staged{}, "up_to_date", "", cleanup, nil
	case stage.ResultNotPromoted:
		return push.Staged{}, "not_offered", "", cleanup, nil
	}
	return push.Staged{}, "failed", res.FailedStage, cleanup, nil
}

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func runPush(args []string, getenv func(string) string, stdin *os.File, stdout io.Writer) int {
	if !config.TierChecksForUpdates || config.Version == "" || getenv("CORAL_AUTO_UPDATE") == "off" {
		printJSON(stdout, map[string]string{"result": "off"})
		return 1
	}
	var cfg push.Config
	dest := ""
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--yes":
			cfg.Yes = true
		case a == "--stage-only":
			cfg.StageOnly = true
		case a == "--coral-update" && i+1 < len(args):
			i++
			cfg.Bin = args[i]
		case a == "--remote-port" && i+1 < len(args):
			i++
			n, err := strconv.Atoi(args[i])
			if err != nil || n < 1 || n > 65535 {
				fmt.Fprintln(os.Stderr, pushUsage)
				return 2
			}
			cfg.Port = n
		case strings.HasPrefix(a, "-") || dest != "":
			fmt.Fprintln(os.Stderr, pushUsage)
			return 2
		default:
			dest = a
		}
	}
	if dest == "" || push.CheckDest(dest) != nil {
		fmt.Fprintln(os.Stderr, pushUsage)
		return 2
	}
	cfg.Runner = push.SSH{Dest: dest}
	cfg.Stage = localStage
	cfg.Progress = os.Stderr
	cfg.Interactive = isTerminal(stdin)
	cfg.Confirm = func(agents int) bool {
		fmt.Fprintf(os.Stderr, "Installing restarts Coral on the remote and stops its %d running agent(s). Type yes to continue: ", agents)
		line, _ := bufio.NewReader(stdin).ReadString('\n')
		return strings.TrimSpace(line) == "yes"
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	res := push.Run(ctx, cfg)
	printJSON(stdout, res)
	switch res.Result {
	case "installed", "up_to_date":
		return 0
	case "staged":
		return 3 // on the remote, not installed: res.FinishCmd finishes it
	}
	return 1
}
