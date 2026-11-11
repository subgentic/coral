//go:build linux

// rehearsal-push is the push rehearsal's own program (#15391, for #15379). It is NOT a released program: no list in tests/release names it and a test runs go list over every released program to
// show none links the rehearsal package. It plays the SENDER's computer and the person's apply against a fake world, with the real code of the push: the release is staged here by the real check (a
// fake GitHub on loopback, a fake Sigstore), push.Run sends it through the real stream into the REAL coral-update's `receive` in the install (run through a stand-in for ssh that executes the remote
// command on this computer with the remote's own data folder), and then the REAL apply (apply.Run, the real Linux platform) verifies what was received, swaps, starts, checks health and rolls back.
// What it cannot do is the ssh hop itself (no keys are used or touched) and the relaunch route (a shipping build answers 404 for it: updateRelaunchFeature is off), so the push stops at "staged".
//
//	rehearsal-push --data-dir D --install I --parent PID --installed N --package P.tar.gz --version N1 [--health-for 15s]
//
// It prints one JSON line per step: {"step":"push",...} with the push's own result, {"step":"ready"} when the apply waits for the server (PID) to end, and {"step":"apply",...}.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/subgentic/coral/internal/updater/apply"
	"github.com/subgentic/coral/internal/updater/push"
	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/testrig"
	"github.com/subgentic/coral/internal/updater/verify"
)

func say(v any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

// localRunner is the stand-in for ssh: it runs the remote command on this computer, in the remote install's own environment (its home and data folder), and gives its stdout back.
type localRunner struct{ env []string }

func (l localRunner) Run(ctx context.Context, remote string, stdin io.Reader) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", remote)
	cmd.Env = l.env
	cmd.Stdin = stdin
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	return out.Bytes(), err
}

func main() { os.Exit(run()) }

func run() int {
	dataDir := flag.String("data-dir", "", "the remote Coral's data folder")
	install := flag.String("install", "", "the remote install folder (its coral-update is the real one: receive and status run from it)")
	parent := flag.Int("parent", 0, "the pid of the server to be replaced")
	installed := flag.String("installed", "", "the installed version")
	pkg := flag.String("package", "", "the new release's tarball")
	version := flag.String("version", "", "the new release's version")
	waitFor := flag.Duration("wait", 2*time.Minute, "how long the apply waits for the server to end")
	healthFor := flag.Duration("health-for", 30*time.Second, "how long the new install has to stay up")
	flag.Parse()
	if *dataDir == "" || *install == "" || *installed == "" || *pkg == "" || *version == "" {
		fmt.Fprintln(os.Stderr, "usage: rehearsal-push --data-dir D --install I --parent PID --installed N --package P --version N1")
		return 2
	}
	data, err := os.ReadFile(*pkg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "package:", err)
		return 2
	}
	signer, err := testrig.NewSigner()
	if err != nil {
		fmt.Fprintln(os.Stderr, "signer:", err)
		return 2
	}
	rel, err := signer.NewRelease(testrig.Spec{Version: *version, Sequence: 1, Package: data})
	if err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		return 2
	}
	gh := testrig.NewFakeGitHub()
	defer gh.Close()
	gh.Publish(rel, true)

	// the sender's own scratch data folder: what this computer stages for the remote never touches the remote's folder
	scratch, err := os.MkdirTemp("", "rehearsal-push-sender.")
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch:", err)
		return 2
	}
	defer os.RemoveAll(scratch)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	env := append(os.Environ(), "CORAL_DATA_DIR="+*dataDir)
	cfg := push.Config{
		Runner: localRunner{env: env},
		Bin:    filepath.Join(*install, "coral-update"),
		Yes:    true, StageOnly: true,
		Stage: func(ctx context.Context, inst string, asset func(string) string) (push.Staged, string, string, func(), error) {
			scfg := stage.Config{DataDir: scratch, Installed: inst, Pins: testrig.Pins(), Verifier: verify.Sigstore{Trust: signer.Trust()}, Asset: testrig.Asset}
			gh.Config(&scfg)
			res := stage.Check(ctx, scfg)
			if res.Result != stage.ResultStaged {
				return push.Staged{}, "failed", res.FailedStage, nil, fmt.Errorf("check: %s", res.Result)
			}
			s, lerr := stage.LoadStaged(scratch)
			if lerr != nil {
				return push.Staged{}, "failed", "staged", nil, lerr
			}
			return push.Staged{Version: s.Version, Dir: s.Dir}, "", "", nil, nil
		},
		Progress: os.Stderr,
	}
	pres := push.Run(ctx, cfg)
	say(map[string]any{"step": "push", "result": pres.Result, "remote": pres.Remote, "version": pres.Version, "failed_stage": pres.Stage, "reason": pres.Reason})
	if pres.Result != "staged" {
		return 1
	}

	platform := &apply.Linux{
		DataDir: *dataDir, Exe: filepath.Join(*install, "coral-update"), Parent: *parent, Self: os.Getpid(), Arch: runtime.GOARCH,
		Manager: func() bool { return false }, WaitFor: *waitFor, HealthFor: *healthFor,
	}
	say(map[string]any{"step": "ready"})
	ares := apply.Run(ctx, apply.Config{
		DataDir: *dataDir, Installed: *installed, Pins: testrig.Pins(), Verifier: verify.Sigstore{Trust: signer.Trust()}, Asset: testrig.Asset, Platform: platform,
	})
	say(map[string]any{"step": "apply", "result": ares.Result, "from": ares.From, "to": ares.To, "failed_stage": ares.FailedStage})
	if ares.Result == apply.ResultRelaunched {
		return 0
	}
	return 1
}
