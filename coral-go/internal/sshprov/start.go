package sshprov

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/secrets"
)

// Starting the installed Coral on the far computer and reading what the hub needs to register it (#11370). The remote listens on its own loopback only (--host 127.0.0.1); the hub reaches it
// through the SSH stream target, never a port.

// RemotePort is the loopback port the remote Coral listens on.
const RemotePort = DefaultPort

var (
	instanceIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)
	apiKeyRe     = regexp.MustCompile(`^[A-Za-z0-9._~+/=-]{16,256}$`)
)

// Stored is the target as the registry stores it (store.RemoteServer.SSHTarget): a config Host name, or user@host:port. ParseTarget and FromAlias read it back.
func (t Target) Stored() string {
	if t.Alias != "" {
		return t.Alias
	}
	h := t.Host
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	return t.User + "@" + h + ":" + strconv.Itoa(t.Port)
}

// AcceptTerms passes the owner's acceptance (the JSON the caller built: version, sha256, by) to the far computer on stdin; the far Coral refuses terms that are not its own. Nothing of the payload is in
// argv, a log or an error.
func (r Runner) AcceptTerms(ctx context.Context, t Target, version string, payload []byte) error {
	res, err := r.RunInput(ctx, t, bytes.NewReader(payload), CmdAcceptTerms, version)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return errors.New("sshprov: the far computer did not accept the terms")
	}
	return nil
}

// stopWait and stopPoll bound how long a stopped Coral is given to be gone; variables for tests.
var (
	stopWait = 15 * time.Second
	stopPoll = time.Second
)

// SetStopTimingForTest shortens how long StopAndConfirm waits (other packages' tests run it against a Coral that will not stop); it returns the function that puts the old values back.
func SetStopTimingForTest(wait, poll time.Duration) (restore func()) {
	oldW, oldP := stopWait, stopPoll
	stopWait, stopPoll = wait, poll
	return func() { stopWait, stopPoll = oldW, oldP }
}

// ErrNotStopped is a Coral that is still there after a stop (a session, or a process of this user running it), or one that could not be checked.
var ErrNotStopped = errors.New("sshprov: Coral did not stop, or that could not be checked")

// What the check after a stop found (CmdCheckStopped's exit codes): a tmux session named coral-server (the Coral of an earlier set-up), a process of this user running a Coral from the install folder, or no way to
// tell (no ps that lists this user's processes).
const (
	StillSession = 1
	StillProcess = 2
	CannotTell   = 3
)

// NotStoppedError is ErrNotStopped with what the last check found (#12947: every case said "did not stop, or that could not be checked"). errors.Is(err, ErrNotStopped) holds.
type NotStoppedError struct{ Found int }

func (e *NotStoppedError) Error() string        { return ErrNotStopped.Error() }
func (e *NotStoppedError) Is(target error) bool { return target == ErrNotStopped }

// StopAndConfirm ends the Coral the recorded PID names (CmdStopDaemon) and the coral-server tmux session of an earlier set-up (matched by its exact name: a far user's "coral-server-notes" is never touched) and then CONFIRMS it: no session by that name and no process of this user running a Coral from the install folder
// (not the port: another user's Coral may hold 8420). It returns nil only on that confirmation; a caller does not delete files or restart on anything else.
func (r Runner) StopAndConfirm(ctx context.Context, t Target) error {
	if _, err := r.Run(ctx, t, CmdStopDaemon); err != nil {
		return err
	}
	if _, err := r.Run(ctx, t, CmdStopTmux); err != nil { // a Coral set up before the daemon start lives in this session
		return err
	}
	deadline := time.Now().Add(stopWait)
	for {
		res, err := r.Run(ctx, t, CmdCheckStopped)
		if err != nil {
			return err
		}
		if res.ExitCode == 0 {
			return nil
		}
		if res.ExitCode == CannotTell || time.Now().After(deadline) {
			return &NotStoppedError{Found: res.ExitCode}
		}
		select {
		case <-ctx.Done():
			return &NotStoppedError{Found: res.ExitCode}
		case <-time.After(stopPoll):
		}
	}
}

// InstallOwnerSecret installs the secret the hub signs its owner stamps for this computer with (#11378): the far Coral's own `hub-owner-secret` command writes it (0600) under the id this hub knows the
// computer by. Both go on stdin; nothing of them is in argv, a log or an error.
func (r Runner) InstallOwnerSecret(ctx context.Context, t Target, version, remoteID, secret string) error {
	payload, err := json.Marshal(map[string]string{"remote": remoteID, "secret": secret})
	if err != nil {
		return err
	}
	res, err := r.RunInput(ctx, t, bytes.NewReader(payload), CmdInstallOwnerSecret, version)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return &OwnerSecretError{ExitCode: res.ExitCode, Stderr: res.Stderr}
	}
	return nil
}

// OwnerSecretError is the far computer's `hub-owner-secret` ending non-zero (#13230: the install failed with nothing said anywhere). The exit code and the start of its stderr are for the hub's log only.
type OwnerSecretError struct {
	ExitCode int
	Stderr   string
}

func (e *OwnerSecretError) Error() string { return "sshprov: the far computer did not take the secret" }

// ErrPortInUse is port 8420 held on the far computer by something that is not this user's coral-server session: another user's Coral, usually. Every Coral set up from here listens on 8420, so a second
// user's would fail to bind and the hub would talk to the first user's with the second's key.
var ErrPortInUse = errors.New("sshprov: port 8420 is already in use on that computer")

// ErrNoTmux is the tmux backend asked for on a computer that has no tmux.
var ErrNoTmux = errors.New("sshprov: tmux is not installed on that computer")

// Backends a start can ask for: "pty" and "tmux" are the person's choice at set up; "keep" is an upgrade's, which starts the new release the way the old one was.
const (
	BackendPTY  = "pty"
	BackendTmux = "tmux"
	BackendKeep = "keep"
)

// Start starts the installed Coral of version as a detached process (CmdStartDaemon) with the backend named (BackendPTY, BackendTmux or BackendKeep; "" is pty), once: one that is already running is left as it is.
// It refuses (ErrPortInUse) when something else holds port 8420, and (ErrNoTmux) when tmux is asked for and is not there.
func (r Runner) Start(ctx context.Context, t Target, version, backend string) error {
	return r.StartWithDataDir(ctx, t, version, backend, "")
}

// StartWithDataDir is Start with the data folder Coral keeps its data in, relative to the home folder there (a set up's choice, ValidDataDir). "" keeps the one recorded at the last start, or the default
// (DefaultDataDir) for a computer with none; the folder is recorded in <install>/datadir so an upgrade and the key reads use it too.
func (r Runner) StartWithDataDir(ctx context.Context, t Target, version, backend, dataDir string) error {
	return r.StartOn(ctx, t, version, backend, dataDir, DefaultPort)
}

// StartOn is StartWithDataDir on the port the person chose (ValidPort, 1024 to 65535; DefaultPort is 8420). The port is checked free first (ErrPortInUse, with what holds it) and given to Coral as --port.
func (r Runner) StartOn(ctx context.Context, t Target, version, backend, dataDir string, port int) error {
	if !ValidPort(port) {
		return ErrNotAllowed
	}
	if dataDir == "" {
		dataDir = "@keep"
	} else if !ValidDataDir(dataDir) {
		return ErrNotAllowed
	}
	if backend == "" {
		backend = BackendPTY
	}
	if chk, err := r.Run(ctx, t, CmdCheckPort, strconv.Itoa(port)); err != nil {
		return err
	} else if chk.ExitCode == 2 {
		pe := &PortInUseError{Port: port}
		pe.Pid, pe.Command = r.PortHolder(ctx, t, port)
		return pe
	}
	res, err := r.Run(ctx, t, CmdStartDaemon, version, backend, dataDir, strconv.Itoa(port))
	if err != nil {
		return err
	}
	if res.ExitCode == 7 {
		return ErrNoTmux
	}
	if res.ExitCode != 0 {
		return &StartError{ExitCode: res.ExitCode}
	}
	return nil
}

// ErrStartFailed is a start command that ended with a code other than 0 (and 7, which is ErrNoTmux).
var ErrStartFailed = errors.New("sshprov: could not start Coral")

// StartError is ErrStartFailed with the code the start command ended with (#12947: "could not start" and nothing else said why). errors.Is(err, ErrStartFailed) holds.
type StartError struct{ ExitCode int }

func (e *StartError) Error() string {
	return "sshprov: could not start Coral (exit code " + strconv.Itoa(e.ExitCode) + ")"
}
func (e *StartError) Is(target error) bool { return target == ErrStartFailed }

// StopWait is how long StopAndConfirm gives a stopped Coral to be gone.
func StopWait() time.Duration { return stopWait }

// ValidVersion is whether v is a release version as the hub names it (what the remote commands accept), so a path with it can be shown to the person.
func ValidVersion(v string) bool { return versionRe.MatchString(v) }

// logTailLines and logTailChars bound what LogTail returns: the last lines of the far Coral's log, each cut, the whole kept at its end.
const (
	logTailLines = 20
	logTailChars = 2000
	logLineChars = 200
)

// LogTail is the end of the far Coral's own log (<install>/coral.log), for the hub's log when a restart fails; "" when there is none or it cannot be read. It is text from the far side: it is cleaned
// (control characters out, each line and the whole cut), goes through the same redaction as session excerpts, and is never shown to the person.
func (r Runner) LogTail(ctx context.Context, t Target) string {
	res, err := r.Run(ctx, t, CmdTailLog)
	if err != nil || res.ExitCode != 0 {
		return ""
	}
	var lines []string
	for _, l := range strings.Split(res.Stdout, "\n") {
		l = strings.TrimSpace(strings.Map(func(r rune) rune {
			if r == '\t' {
				return ' '
			}
			if r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}, l))
		if l == "" {
			continue
		}
		if rs := []rune(l); len(rs) > logLineChars {
			l = string(rs[:logLineChars]) + "…"
		}
		lines = append(lines, l)
	}
	if len(lines) > logTailLines {
		lines = lines[len(lines)-logTailLines:]
	}
	text := strings.Join(lines, " | ")
	if rs := []rune(text); len(rs) > logTailChars {
		text = "…" + string(rs[len(rs)-logTailChars:])
	}
	if text == "" {
		return ""
	}
	red, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		return "(not shown: it could not be checked for secrets)"
	}
	return string(red)
}

// EnsureInstanceID makes the instance id on the far computer (once; a re-run reads the same one) and returns it: 32 lower-case hex digits, nothing else.
func (r Runner) EnsureInstanceID(ctx context.Context, t Target) (string, error) {
	res, err := r.Run(ctx, t, CmdEnsureInstanceID)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(res.Stdout)
	if res.ExitCode != 0 || !instanceIDRe.MatchString(id) {
		return "", errors.New("sshprov: the instance id is not 32 hex digits")
	}
	return id, nil
}

// keyPoll is how long ReadAPIKey waits between tries, and keyWait how long it tries in all; variables for tests.
var (
	keyPoll = 2 * time.Second
	keyWait = 90 * time.Second
)

// ReadAPIKey reads the remote's API key, waiting for a Coral that is still starting to make it. The key is returned to the caller and is in no log, argv or error here; anything that is not a key of
// the expected shape is not one.
func (r Runner) ReadAPIKey(ctx context.Context, t Target, version string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, keyWait)
	defer cancel()
	for {
		res, err := r.Run(ctx, t, CmdReadAPIKey, version)
		if err == nil && res.ExitCode == 0 {
			if key := strings.TrimSpace(res.Stdout); apiKeyRe.MatchString(key) {
				return key, nil
			}
		} else if errors.Is(err, ErrHostKey) || errors.Is(err, ErrHostKeyChanged) || errors.Is(err, ErrNotAllowed) {
			return "", err
		}
		select {
		case <-ctx.Done():
			return "", errors.New("sshprov: the remote has no API key yet")
		case <-time.After(keyPoll):
		}
	}
}

// PortInUseError is ErrPortInUse with what holds the port, when the far computer could say: Pid 0 when it could not (another user's process is not shown to this one, and neither lsof nor ss may be there).
// Pid is digits and Command a short name of letters, digits and . _ - only; anything else the far side printed is dropped (#12027).
type PortInUseError struct {
	Port    int // the port that was asked for
	Pid     int
	Command string
}

func (e *PortInUseError) Error() string        { return ErrPortInUse.Error() }
func (e *PortInUseError) Is(target error) bool { return target == ErrPortInUse }

var portHolderRe = regexp.MustCompile(`^([0-9]{1,8}) ([A-Za-z0-9._-]{1,40})$`)

// PortHolder is the pid and command name of what listens on the port there, or 0 and "" when that is not known.
func (r Runner) PortHolder(ctx context.Context, t Target, port int) (int, string) {
	res, err := r.Run(ctx, t, CmdPortHolder, strconv.Itoa(port))
	if err != nil || res.ExitCode != 0 {
		return 0, ""
	}
	m := portHolderRe.FindStringSubmatch(strings.TrimSpace(res.Stdout))
	if m == nil {
		return 0, ""
	}
	pid, _ := strconv.Atoi(m[1])
	return pid, m[2]
}
