package push

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/updater/status"
)

// Runner runs one command on the remote computer, with stdin, and returns its stdout (at most MaxOutput bytes). Production is SSH; a test supplies a stand-in.
type Runner interface {
	Run(ctx context.Context, remote string, stdin io.Reader) ([]byte, error)
}

// MaxOutput bounds what is read back from the remote.
const MaxOutput = 64 << 10

var (
	destRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@:%\[\]-]{0,252}$`)
	absRe  = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,200}$`)
)

// CheckDest accepts what a person types for ssh: a host, user@host, an alias from their ssh config, never anything that starts with "-" (an option) or holds a space or a shell character.
func CheckDest(d string) error {
	if !destRe.MatchString(d) {
		return errors.New("the destination is not a plain ssh host name")
	}
	return nil
}

// CheckBin accepts an absolute path of plain characters: the one thing that is put into a command line the remote's login shell reads.
func CheckBin(p string) error {
	if !absRe.MatchString(p) || strings.Contains(p, "..") || strings.Contains(p, "//") {
		return errors.New("the remote program's path is not a plain absolute path")
	}
	return nil
}

// SSHArgs is the whole argv of ssh for dest and one remote command: agent and X11 forwarding off, no terminal, and "--" before the destination so it can never be read as an option. Nothing
// about host keys is set here: they are the operator's ssh configuration's job (no StrictHostKeyChecking or UserKnownHostsFile override, ever).
func SSHArgs(dest, remote string) ([]string, error) {
	if err := CheckDest(dest); err != nil {
		return nil, err
	}
	return []string{"-a", "-x", "-T", "--", dest, remote}, nil
}

// SSH runs commands with the system ssh.
type SSH struct {
	Dest string
	Bin  string // "ssh" unless a test says otherwise
}

type capWriter struct {
	b   bytes.Buffer
	max int
}

func (c *capWriter) Write(p []byte) (int, error) {
	n := len(p) // report everything as written: a short count would fail the command's copy, and the rest is simply dropped
	if c.b.Len()+len(p) > c.max {
		p = p[:max(0, c.max-c.b.Len())]
	}
	c.b.Write(p)
	return n, nil
}

func (s SSH) Run(ctx context.Context, remote string, stdin io.Reader) ([]byte, error) {
	args, err := SSHArgs(s.Dest, remote)
	if err != nil {
		return nil, err
	}
	bin := s.Bin
	if bin == "" {
		bin = "ssh"
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdin = stdin
	out := &capWriter{max: MaxOutput}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return out.b.Bytes(), errors.New("ssh to the remote failed")
	}
	return out.b.Bytes(), nil
}

// ProbeScript is fixed text, run by /bin/sh on the remote: no value from anywhere is put into it, and it holds no quote, backslash or history character a login shell (sh, bash, zsh,
// fish, csh) could read differently. It prints the OS, the machine, and the absolute path of the first coral-update it finds (PATH of a non-interactive ssh is often short, so the usual places too).
const ProbeScript = `/bin/sh -c 'uname -s; uname -m; for p in "$(command -v coral-update 2>/dev/null)" "$HOME/.local/bin/coral-update" /usr/local/bin/coral-update /opt/coral/coral-update "$HOME/coral/coral-update" /Applications/Coral.app/Contents/MacOS/coral-update; do if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; break; fi; done'`

// Probe is what the remote said about itself, after the shape checks.
type Probe struct {
	OS   string // linux or darwin
	Arch string // amd64 or arm64
	Bin  string // absolute path of its coral-update
}

// ErrUnsupported is a remote this push does not serve (Windows, another OS or machine).
var ErrUnsupported = errors.New("unsupported remote")

// ParseProbe checks the probe's output against fixed shapes and refuses the rest.
func ParseProbe(out []byte) (Probe, error) {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 3 {
		return Probe{}, errors.New("the remote has no coral-update (pass --coral-update /absolute/path)")
	}
	var p Probe
	switch strings.TrimSpace(lines[0]) {
	case "Linux":
		p.OS = "linux"
	case "Darwin":
		p.OS = "darwin"
	default:
		return Probe{}, fmt.Errorf("%w: only Linux and macOS remotes are served", ErrUnsupported)
	}
	switch strings.TrimSpace(lines[1]) {
	case "x86_64", "amd64":
		p.Arch = "amd64"
	case "aarch64", "arm64":
		p.Arch = "arm64"
	default:
		return Probe{}, fmt.Errorf("%w: the machine type is not amd64 or arm64", ErrUnsupported)
	}
	p.Bin = strings.TrimSpace(lines[2])
	if err := CheckBin(p.Bin); err != nil {
		return Probe{}, err
	}
	return p, nil
}

// Asset is the package this remote takes, named as the release names it (the updater's own table).
func (p Probe) Asset(version string) string {
	if p.OS == "darwin" {
		return "Coral.v" + version + ".dmg"
	}
	return "coral-linux-" + p.Arch + "-" + version + ".tar.gz"
}

// Staged is what the local staging step produced: the verified folder.
type Staged struct {
	Version string
	Dir     string
}

// Config is one push.
type Config struct {
	Runner Runner
	// Bin overrides the probe's path of the remote's coral-update ("" = probe).
	Bin string
	// Stage verifies the newest release this computer would offer for a remote at installed, for asset, into a private folder, and returns it. result is "" for a staged release or a
	// fixed word (up_to_date, not_offered, failed) with the failed stage in stageWord. The returned cleanup removes the folder; it is called on every path.
	Stage func(ctx context.Context, installed string, asset func(version string) string) (s Staged, result, stageWord string, cleanup func(), err error)
	// Port is the remote Coral's port when it is not the default (0 = default); passed to its relaunch command.
	Port int
	// Interactive is whether a person can be asked; Yes is the explicit consent; StageOnly stops after the files are on the remote.
	Interactive, Yes, StageOnly bool
	Confirm                     func(agents int) bool
	// Poll and Wait: how often and how long the version on the remote is watched after the relaunch.
	Poll, Wait time.Duration
	Progress   io.Writer
}

// Result is the whole of what a push reports: fixed words and versions.
type Result struct {
	Result    string `json:"result"` // installed, staged, up_to_date, not_offered, unsupported, declined, rolled_back, failed
	Remote    string `json:"remote,omitempty"`
	Version   string `json:"version,omitempty"`
	Stage     string `json:"failed_stage,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Agents    int    `json:"agents,omitempty"`
	FinishCmd string `json:"finish,omitempty"` // the exact command that finishes by hand when the push stopped at "staged"
}

var wordRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

func word(s string) string {
	if wordRe.MatchString(s) {
		return s
	}
	return "other"
}

func (c *Config) portArg() string {
	if c.Port > 0 && c.Port < 65536 {
		return fmt.Sprintf(" --port %d", c.Port)
	}
	return ""
}

func (c *Config) say(format string, a ...any) {
	if c.Progress != nil {
		fmt.Fprintf(c.Progress, format+"\n", a...)
	}
}

func parseJSON(b []byte, v any) bool {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(b)))
	return dec.Decode(v) == nil
}

func (c *Config) remoteStatus(ctx context.Context, bin string) (status.Out, bool) {
	var st status.Out
	b, err := c.Runner.Run(ctx, bin+" status --json", nil)
	return st, err == nil && parseJSON(b, &st)
}

// FilesOf lists the six files of a staged folder for the stream: regular files only (a link or anything else in the folder is refused), sized from the file itself.
func FilesOf(dir, asset string) ([]File, error) {
	var out []File
	for _, n := range Names(asset) {
		p := filepath.Join(dir, n)
		fi, err := os.Lstat(p)
		if err != nil || !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("the staged file %s is missing or not a plain file", n)
		}
		out = append(out, File{Name: n, Size: fi.Size(), Open: func() (io.ReadCloser, error) { return os.Open(p) }})
	}
	return out, nil
}

// Run is one push. Nothing on the remote changes before the stream is fully received and renamed into place, and every check on the remote's side is a warning, never a block.
func Run(ctx context.Context, c Config) Result {
	fail := func(reason string) Result { return Result{Result: "failed", Reason: reason} }
	b, err := c.Runner.Run(ctx, ProbeScript, nil)
	if err != nil {
		return fail("ssh")
	}
	p, err := ParseProbe(b)
	if c.Bin != "" {
		if cerr := CheckBin(c.Bin); cerr != nil {
			return fail("bad_path")
		}
		if err != nil && errors.Is(err, ErrUnsupported) {
			return Result{Result: "unsupported", Reason: "remote_os"}
		}
		if err != nil { // the probe found no coral-update; the operator named one
			p = Probe{}
			if lines := strings.Split(strings.TrimSpace(string(b)), "\n"); len(lines) >= 2 {
				p, err = ParseProbe([]byte(lines[0] + "\n" + lines[1] + "\n" + c.Bin))
			}
		}
		p.Bin = c.Bin
	}
	if err != nil {
		if errors.Is(err, ErrUnsupported) {
			return Result{Result: "unsupported", Reason: "remote_os"}
		}
		return fail("no_updater")
	}
	if p.Bin == "" || p.OS == "" {
		return fail("no_updater")
	}
	st, ok := c.remoteStatus(ctx, p.Bin)
	if !ok || !PlainVersion(st.Installed) {
		return fail("remote_status")
	}
	res := Result{Remote: st.Installed}
	var probeOut struct {
		Receive int `json:"receive"`
	}
	if b, err := c.Runner.Run(ctx, p.Bin+" receive --probe", nil); err != nil || !parseJSON(b, &probeOut) || probeOut.Receive != 1 {
		res.Result, res.Reason = "unsupported", "remote_too_old"
		return res
	}
	c.say("remote: %s %s, coral %s", p.OS, p.Arch, st.Installed)
	staged, result, stageWord, cleanup, err := c.Stage(ctx, st.Installed, p.Asset)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil || result != "" {
		if result == "" {
			result = "failed"
		}
		res.Result, res.Stage = result, word(stageWord)
		return res
	}
	if !PlainVersion(staged.Version) {
		res.Result, res.Reason = "not_offered", "prerelease"
		return res
	}
	res.Version = staged.Version
	asset := p.Asset(staged.Version)
	files, err := FilesOf(staged.Dir, asset)
	if err != nil {
		res.Result, res.Reason = "failed", "staged_files"
		return res
	}
	c.say("verified %s here; sending", staged.Version)
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(Write(pw, asset, files)) }()
	if _, err := c.Runner.Run(ctx, p.Bin+" receive --version "+staged.Version, pr); err != nil {
		pr.Close()
		res.Result, res.Reason = "failed", "send"
		return res
	}
	res.FinishCmd = "ssh <host> " + p.Bin + " relaunch" + c.portArg()
	if c.StageOnly {
		res.Result = "staged"
		return res
	}
	var chk struct {
		Result string `json:"result"`
		Reason string `json:"reason"`
		Agents int    `json:"agents"`
	}
	b, _ = c.Runner.Run(ctx, p.Bin+" relaunch --check"+c.portArg(), nil)
	if !parseJSON(b, &chk) || chk.Result != "ready" {
		res.Result, res.Reason = "staged", word(chk.Reason) // warn, don't block: it is on the remote, the install waits for a person there
		if res.Reason == "other" && chk.Reason == "" {
			res.Reason = "not_ready"
		}
		return res
	}
	res.Agents = chk.Agents
	if chk.Agents > 0 && !c.Yes {
		if !c.Interactive || c.Confirm == nil || !c.Confirm(chk.Agents) {
			res.Result, res.Reason = "staged", "consent_needed"
			return res
		}
	} else if !c.Yes && !c.Interactive {
		res.Result, res.Reason = "staged", "consent_needed"
		return res
	}
	b, _ = c.Runner.Run(ctx, p.Bin+" relaunch"+c.portArg(), nil)
	var rl struct {
		Result string `json:"result"`
		Reason string `json:"reason"`
	}
	if !parseJSON(b, &rl) || rl.Result != "relaunched" {
		res.Result, res.Reason = "staged", word(rl.Reason)
		if !parseJSON(b, &rl) {
			res.Reason = "relaunch_unclear"
		}
		return res
	}
	return c.watch(ctx, p, res)
}

// watch reads the version on the remote until it is the pushed one (installed), or until the apply's own record says it rolled back, or the wait is over.
func (c *Config) watch(ctx context.Context, p Probe, res Result) Result {
	poll, wait := c.Poll, c.Wait
	if poll <= 0 {
		poll = 3 * time.Second
	}
	if wait <= 0 {
		wait = 3 * time.Minute
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			res.Result, res.Reason = "failed", "cancelled"
			return res
		case <-time.After(poll):
		}
		st, ok := c.remoteStatus(ctx, p.Bin) // the remote's coral-update: the restart may drop an ssh now and then, so a miss is retried
		if !ok {
			continue
		}
		if st.Installed == res.Version {
			res.Result = "installed"
			return res
		}
		if st.LastRolled != nil && st.LastRolled.To == res.Version && st.Installed == res.Remote {
			res.Result, res.Reason = "rolled_back", word(st.LastRolled.Reason)
			return res
		}
	}
	res.Result, res.Reason = "failed", "timeout"
	return res
}
