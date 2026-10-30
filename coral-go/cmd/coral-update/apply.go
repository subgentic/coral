package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/sigstore/sigstore-go/pkg/root"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/updater/apply"
	"github.com/subgentic/coral/internal/updater/trigger"
	"github.com/subgentic/coral/internal/updater/verify"
)

// parentAtStart is the pid of the process that started this one (the server, which quits to be replaced), taken before anything else: it is
// never an argument.
var parentAtStart = os.Getppid()

func runApply(ctx context.Context, stdout io.Writer, dataDir string, trust root.TrustedMaterial, source verify.TrustSource) int {
	// Windows asks the person at this computer (UAC) to allow the install, so the apply starts only after a click in Settings: the dashboard's "Install update" leaves a
	// one-time marker (internal/updater/trigger) and this run consumes it before anything else. Run by hand, from a script or stale, it answers and asks nothing (#166, N5).
	if runtime.GOOS == "windows" {
		if res := installRequest(dataDir, time.Now()); res != "" {
			o := output{Result: res, Installed: config.Version, Trust: string(source)}
			if res == resultRequestExpired || res == resultRequestInvalid { // a click was made and the server quit for it: Coral is started again (#332)
				o.RestartFailed = !restartFromMarker(dataDir, clickedInstallDir)
			}
			printApply(stdout, dataDir, o)
			return 0
		}
	}
	var platform apply.Platform
	pins := verify.DefaultPins()
	switch runtime.GOOS {
	case "darwin":
		platform = &apply.Mac{Run: apply.NewRunner(), TeamIDs: pins.MacTeamIDs, Parent: parentAtStart, Self: os.Getpid(), DataDir: dataDir, CoralVersion: config.Version}
	case "linux":
		platform = &apply.Linux{DataDir: dataDir, Parent: parentAtStart, Self: os.Getpid(), Arch: runtime.GOARCH}
	case "windows":
		// A per-machine MSI: a major upgrade by Windows Installer, not a build-and-swap (#162, apply_msi.go).
		res := runApplyWindows(ctx, dataDir, trust, pins)
		if installedNothingAndLeftNoCoral(res) {
			res.RestartFailed = !restartFromMarker(dataDir, clickedInstallDir)
		}
		printApply(stdout, dataDir, output{Result: res.Result, Installed: res.From, Version: res.To, FailedStage: res.FailedStage, RestartFailed: res.RestartFailed, Trust: string(source)})
		return 0
	default:
		printApply(stdout, dataDir, output{Result: "unsupported_platform", Installed: config.Version, Trust: string(source)})
		return 0
	}
	res := apply.Run(ctx, apply.Config{
		DataDir:   dataDir,
		Installed: config.Version,
		Pins:      pins,
		Verifier:  verify.Sigstore{Trust: trust},
		Asset:     assetName(runtime.GOOS, runtime.GOARCH, false),
		Platform:  platform,
	})
	printApply(stdout, dataDir, output{Result: res.Result, Installed: res.From, Version: res.To, FailedStage: res.FailedStage, RestartFailed: res.RestartFailed, Trust: string(source)})
	return 0
}

// The results of an apply that was not asked for by a click in Settings: fixed words, printed for display only.
const (
	resultNotRequested   = "not_requested"
	resultRequestExpired = "request_expired"
	resultRequestInvalid = "request_invalid"
)

// clickedVersion is the staged version the person saw when they clicked Install update (the marker's), set by a good installRequest: the Windows apply compares it with the
// version it is about to install and refuses a stale click before any prompt (#82, #80's ClickedVersion).
var clickedVersion string

// clickedInstallDir is the folder of the server that quit for this run (the marker's): where Coral is started again when the apply installs nothing (#5946).
var clickedInstallDir string

// installRequest consumes the dashboard's one-time install marker and returns "" when there was a good one, else the result word to print. The marker is deleted
// whatever it held, so a second run finds none.
func installRequest(dataDir string, now time.Time) string {
	clickedVersion, clickedInstallDir = "", ""
	m, err := trigger.Consume(dataDir, now)
	switch {
	case err == nil:
		clickedVersion = m.Version
		clickedInstallDir = m.InstallDir
		return ""
	case errors.Is(err, trigger.ErrNoMarker):
		return resultNotRequested
	case errors.Is(err, trigger.ErrMarkerExpired):
		clickedInstallDir = m.InstallDir
		return resultRequestExpired
	default:
		return resultRequestInvalid
	}
}

// applyLogMax is how big the apply's own log may grow before it starts again: a few hundred answers.
const applyLogMax = 64 << 10

// printApply prints the apply's answer and keeps it in <data dir>/updates/apply.log. The server that starts this program (the relaunch from the dashboard or the Hub) gives it nowhere to
// print, so an apply that ended with nothing installed left no trace of why (#11155, found in the operator's 2.0.3 -> 2.0.5 update, #11151). A line is the time and the answer; the file
// is the user's alone, never followed through a link, and starts again when it is large.
func printApply(w io.Writer, dataDir string, o output) {
	print(w, o)
	if dataDir == "" {
		return
	}
	dir := filepath.Join(dataDir, "updates")
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return
	}
	p := filepath.Join(dir, "apply.log")
	flags := os.O_WRONLY | os.O_APPEND | os.O_CREATE
	if fi, err := os.Lstat(p); err == nil {
		if !fi.Mode().IsRegular() {
			return
		}
		if fi.Size() > applyLogMax {
			flags |= os.O_TRUNC
		}
	}
	f, err := os.OpenFile(p, flags, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	b, err := json.Marshal(o)
	if err != nil {
		return
	}
	_, _ = f.WriteString(time.Now().UTC().Format(time.RFC3339) + " " + string(b) + "\n")
}
