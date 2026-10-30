package sshprov

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// Command is one of the CLOSED set of things the hub may run on the remote. There is no way to run a command that is not in this list: a Command names a fixed template, and its arguments are
// validated for the template's slot before they are put in. No user text ever reaches a shell string unvalidated.
type Command int

const (
	// CmdUname asks the remote's system and machine ("Linux x86_64"), to pick the package.
	CmdUname Command = iota
	// CmdHasTmux asks whether tmux is installed (exit 0 when it is).
	CmdHasTmux
	// CmdHasSystemdUser asks whether a systemd user manager answers (exit 0 when it does).
	CmdHasSystemdUser
	// CmdSha256 prints the SHA-256 of a file under the install folder; arg 0 is the file's path below it.
	CmdSha256
	// CmdReadInstanceID prints the remote Coral's instance id file, if there is one.
	CmdReadInstanceID
	// CmdMkVersionDir makes (0700) the folder of one release under the install folder; arg 0 is the version.
	CmdMkVersionDir
	// CmdReceive writes its stdin to <install>/<version>/package.tar.gz (the package, streamed from the hub); arg 0 is the version.
	CmdReceive
	// CmdTarList prints the member names of that package; arg 0 is the version.
	CmdTarList
	// CmdUnpack unpacks that package into <install>/<version>/root and records its SHA-256 in <install>/<version>/package.sha256; arg 0 is the version.
	CmdUnpack
	// CmdStartTmux starts the installed Coral of version arg 0 in a tmux session named coral-server, listening on loopback only, with its data under the install folder; nothing is done if the session exists.
	CmdStartTmux
	// CmdEnsureInstanceID makes the provisioner's instance id file (32 hex digits, once) and prints it.
	CmdEnsureInstanceID
	// CmdReadAPIKey prints the API key of the Coral of version arg 0 (its data folder under the install folder); it fails until that Coral has started once.
	CmdReadAPIKey
	// CmdFreeKB prints the free space, in KiB, of the file system that holds the home folder (the install folder lives under it).
	CmdFreeKB
	// CmdReadInstalledSum prints that recorded SHA-256, if the release is installed; arg 0 is the version.
	CmdReadInstalledSum
)

// InstallDir is where everything the provisioner puts on the remote lives, under the remote user's home. Never outside it.
const InstallDir = ".coral-server"

type spec struct {
	// template is the remote shell text, with %s for each validated argument in order.
	template string
	args     []*regexp.Regexp
	// timeout overrides the runner's (a package upload takes longer than a question).
	timeout time.Duration
}

// versionRe is a release version as the hub names it: numbers and an optional suffix, never a path.
var versionRe = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[A-Za-z0-9.]{1,32})?$`)

var relPathRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$`)

var specs = map[Command]spec{
	CmdUname:          {template: "uname -sm"},
	CmdHasTmux:        {template: "command -v tmux >/dev/null 2>&1"},
	CmdHasSystemdUser: {template: "systemctl --user show-environment >/dev/null 2>&1"},
	CmdSha256:         {template: "cd \"$HOME/" + InstallDir + "\" && { sha256sum -- '%[1]s' 2>/dev/null || shasum -a 256 -- '%[1]s'; }", args: []*regexp.Regexp{relPathRe}},
	CmdReadInstanceID: {template: "cat \"$HOME/" + InstallDir + "/instance-id\" 2>/dev/null"},
	CmdMkVersionDir:   {template: "umask 077 && mkdir -p \"$HOME/" + InstallDir + "/%[1]s\" && chmod 700 \"$HOME/" + InstallDir + "\" \"$HOME/" + InstallDir + "/%[1]s\"", args: []*regexp.Regexp{versionRe}},
	CmdReceive:        {template: "umask 077 && cat > \"$HOME/" + InstallDir + "/%s/package.tar.gz\"", args: []*regexp.Regexp{versionRe}, timeout: 15 * time.Minute},
	CmdTarList:        {template: "cd \"$HOME/" + InstallDir + "/%s\" && tar -tzf package.tar.gz", args: []*regexp.Regexp{versionRe}, timeout: 2 * time.Minute},
	CmdStartTmux: {template: "umask 077 && mkdir -p \"$HOME/" + InstallDir + "/data\" && { tmux has-session -t coral-server 2>/dev/null || tmux new-session -d -s coral-server " +
		"\"exec \\\"$HOME/" + InstallDir + "/%[1]s/root/coral\\\" --host 127.0.0.1 --port 8420 --no-browser --backend tmux --home \\\"$HOME/" + InstallDir + "/data\\\"\"; }", args: []*regexp.Regexp{versionRe}},
	CmdEnsureInstanceID: {template: "umask 077 && mkdir -p \"$HOME/" + InstallDir + "\" && f=\"$HOME/" + InstallDir + "/instance-id\" && { [ -s \"$f\" ] || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > \"$f\"; } && cat \"$f\""},
	CmdReadAPIKey:       {template: "\"$HOME/" + InstallDir + "/%s/root/coral\" api-key --home \"$HOME/" + InstallDir + "/data\" 2>/dev/null", args: []*regexp.Regexp{versionRe}},
	CmdFreeKB:           {template: "df -Pk \"$HOME\" | awk 'NR==2 {print $4}'"},
	// The recorded sum goes FIRST: a re-unpack that is interrupted leaves no sum next to a half-written root, so the next run does not say "already installed". It is written last.
	CmdUnpack: {template: "umask 077 && cd \"$HOME/" + InstallDir + "/%[1]s\" && rm -f package.sha256 && rm -rf root && mkdir root && tar -xzf package.tar.gz --no-same-owner -C root && " +
		"{ sha256sum package.tar.gz 2>/dev/null || shasum -a 256 package.tar.gz; } | cut -d' ' -f1 > package.sha256", args: []*regexp.Regexp{versionRe}, timeout: 5 * time.Minute},
	CmdReadInstalledSum: {template: "cat \"$HOME/" + InstallDir + "/%s/package.sha256\" 2>/dev/null", args: []*regexp.Regexp{versionRe}},
}

// ErrNotAllowed is a command or argument the closed list does not allow.
var ErrNotAllowed = errors.New("sshprov: that remote command is not allowed")

// remoteText is the shell text of c with its arguments, or ErrNotAllowed. An argument must match the template's pattern for its slot and so has no quote, space or "..".
func remoteText(c Command, args ...string) (string, error) {
	s, ok := specs[c]
	if !ok || len(args) != len(s.args) {
		return "", ErrNotAllowed
	}
	vals := make([]any, len(args))
	for i, a := range args {
		if !s.args[i].MatchString(a) || strings.Contains(a, "..") {
			return "", fmt.Errorf("%w: argument %d", ErrNotAllowed, i+1)
		}
		vals[i] = a
	}
	return fmt.Sprintf(s.template, vals...), nil
}

// Runner runs the closed commands over the system ssh with the user's own agent, config and known_hosts. Host-key checking is never turned off: an unknown or changed key stops the run with
// ErrHostKey. Nothing a command prints is kept in argv or logs by the runner.
type Runner struct {
	// SSH is the ssh program; empty means "ssh" from the PATH. Tests point it at a fake.
	SSH string
	// Timeout bounds one command (default 30s).
	Timeout time.Duration
	// KeyScan is the ssh-keyscan program of the host-key step; empty means "ssh-keyscan" from the PATH.
	KeyScan string
}

// Result is what a command printed and how it ended.
type Result struct {
	Stdout   string
	ExitCode int
}

// ErrHostKey is an unknown or changed host key (ssh refused it). The owner confirms or investigates; the runner never accepts it.
var ErrHostKey = errors.New("sshprov: the host key is unknown or has changed")

// ErrHostKeyChanged is a host whose key is known and no longer matches: never offered for trust, the owner investigates (it may be another machine at that address).
var ErrHostKeyChanged = errors.New("sshprov: the host key has changed")

// ErrConnect is a failure to connect or sign in (ssh exit 255) other than the host key.
var ErrConnect = errors.New("sshprov: could not connect")

// sshOptions are on every ssh the hub starts: no prompt, no unknown host key, no forwarding of the hub user's agent or display, no command from the config.
// ClearAllForwardings does not stop -W, which is the one forward the stream target asks for.
var sshOptions = []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no", "-o", "LogLevel=ERROR",
	"-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none"}

const maxOutput = 64 << 10

// shQuote is s as one single-quoted word for the remote shell.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// minimalEnv is all ssh is given: the hub's own CORAL_* values and anything else in its environment never reach a user's SendEnv or ProxyCommand. SSH_AUTH_SOCK is the user's agent.
func minimalEnv() []string {
	env := []string{"LC_ALL=C"}
	for _, k := range []string{"HOME", "USER", "PATH", "SSH_AUTH_SOCK"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

type capped struct {
	b bytes.Buffer
}

func (c *capped) Write(p []byte) (int, error) {
	if room := maxOutput - c.b.Len(); room > 0 {
		c.b.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// Run runs command c with args on t. The argv is fixed: options, "--", the destination, then the one validated text as a single argument.
func (r Runner) Run(ctx context.Context, t Target, c Command, args ...string) (Result, error) {
	return r.RunInput(ctx, t, nil, c, args...)
}

// RunInput is Run with input on the command's stdin (the package for CmdReceive).
func (r Runner) RunInput(ctx context.Context, t Target, input io.Reader, c Command, args ...string) (Result, error) {
	text, err := remoteText(c, args...)
	if err != nil {
		return Result{}, err
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if st := specs[c].timeout; st > timeout {
		timeout = st
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ssh := r.SSH
	if ssh == "" {
		ssh = "ssh"
	}
	argv := append([]string{}, sshOptions...)
	argv = append(argv, t.Args()...)
	argv = append(argv, "--", t.Destination(), "sh -c "+shQuote(text))
	cmd := executil.Command(ctx, ssh, argv...)
	var out, errOut capped
	cmd.Stdout, cmd.Stderr, cmd.Stdin = &out, &errOut, input
	cmd.Env = minimalEnv()
	runErr := cmd.Run()
	res := Result{Stdout: out.b.String()}
	if runErr == nil {
		return res, nil
	}
	var ee interface{ ExitCode() int }
	if errors.As(runErr, &ee) {
		res.ExitCode = ee.ExitCode()
		if res.ExitCode == 255 {
			if strings.Contains(errOut.b.String(), "REMOTE HOST IDENTIFICATION HAS CHANGED") {
				return res, ErrHostKeyChanged
			}
			if strings.Contains(errOut.b.String(), "Host key verification failed") {
				return res, ErrHostKey
			}
			return res, ErrConnect
		}
		return res, nil // the command ran and exited non-zero: the caller reads ExitCode (tmux absent is not an error)
	}
	if ctx.Err() != nil {
		return res, fmt.Errorf("%w: timed out", ErrConnect)
	}
	return res, runErr
}
