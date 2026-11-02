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
	"unicode/utf8"

	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/secrets"
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
	// CmdStartDaemon starts the installed Coral of version arg 0 as a detached process (setsid, nohup, no terminal), listening on loopback only, with its data under the install folder: its PID in <install>/coral.pid
	// (written by the process itself, which is the one that execs Coral) and its output appended to <install>/coral.log (moved to coral.log.1, replacing the older one, at a start when it is over 10 MiB).
	// Arg 1 is the terminal backend: "pty" (agents end with Coral) or "tmux" (they survive a restart; exit 7 when tmux is not installed), written to <install>/backend; "keep" reads that file, and with none
	// (a server set up before the choice existed, in tmux) takes tmux when it is installed, else pty. Nothing is done when the recorded PID is a live Coral of this install.
	// Its standard input is /dev/null: a Coral with a terminal asks "Enable remote access? [y/N]" before it listens and waits for an answer nobody gives (the setup then timed out waiting for its API key).
	CmdStartDaemon
	// CmdEnsureInstanceID makes the provisioner's instance id file (32 hex digits, once) and prints it.
	CmdEnsureInstanceID
	// CmdReadAPIKey prints the API key of the Coral of version arg 0 (its data folder under the install folder); it fails until that Coral has started once.
	CmdReadAPIKey
	// CmdAcceptTerms hands the owner's acceptance of the terms (JSON, on STDIN, never in argv) to the Coral of version arg 0 (`coral accept-terms`); it refuses terms other than its own.
	CmdAcceptTerms
	// CmdStopTmux ends the coral-server tmux session (the Coral in it); nothing is done if there is none.
	CmdStopTmux
	// CmdStopDaemon ends the Coral the recorded PID names, when that PID is alive and its command line is a Coral from the install folder (aliveTest): a SIGTERM, nothing else, and nothing when there is no
	// such process. A Coral that was started in the tmux session of an earlier set-up is ended by CmdStopTmux.
	CmdStopDaemon
	// CmdRemoveInstalls deletes the installed releases (the numbered folders) under the install folder and keeps the data, the instance id and the key.
	CmdRemoveInstalls
	// CmdRemoveAll deletes the whole install folder: releases, data (the key, the history), the instance id.
	CmdRemoveAll
	// CmdCheckStopped is the check after a stop: exit 0 only when there is no tmux session named exactly coral-server and no process of THIS user is running a Coral from the install folder (read from ps);
	// 1 for a session, 2 for such a process, 3 when it cannot tell (no ps -u): all of them are "not confirmed". It is the user's own process that counts, never the port: another user of the same computer
	// may hold 8420 with their own Coral, and that is not this user's stop failing.
	CmdCheckStopped
	// CmdInstallOwnerSecret runs the Coral of version arg 0's `hub-owner-secret` with the id and the secret as JSON on STDIN (never argv): the human act that installs the secret its owner stamps are
	// verified with (#11378).
	CmdInstallOwnerSecret
	// CmdFreeKB prints the free space, in KiB, of the file system that holds the home folder (the install folder lives under it).
	CmdFreeKB
	// CmdReadInstalledSum prints that recorded SHA-256, if the release is installed; arg 0 is the version.
	CmdReadInstalledSum
	// CmdDownload downloads the release package for the far computer's own platform from the release URL, into <install>/<version>/package.tar.gz, and checks its SHA-256 against the one the hub gives (from its
	// own verified SHA256SUMS): args are the version, the architecture and the expected SHA-256. https only (redirects too, at most three), 300 MiB at most. Exit 6: no curl; 4: the download failed; 5: the hash
	// is not the expected one (the file is deleted, nothing is unpacked).
	CmdDownload
	// CmdCheckPort is the check before a start: exit 0 when this user's coral-server session exists (a start leaves it as it is) or nothing listens on port 8420 (read from /proc/net/tcp and tcp6, Linux),
	// 2 when something does (another user's Coral, or any program), 3 when it cannot tell (the start then goes ahead as it always did).
	CmdCheckPort
)

// aliveTest is true (exit 0) when <install>/coral.pid names a live process of this user whose command line is a Coral from the install folder: the daemon a start left. A recycled PID of another program fails the
// command-line test, so it is never taken for Coral (and never signalled).
const aliveTest = "{ [ -s \"$HOME/" + InstallDir + "/coral.pid\" ] && ps -p \"$(cat \"$HOME/" + InstallDir + "/coral.pid\")\" -o args= 2>/dev/null | grep -F -- \"$HOME/" + InstallDir + "/\" | grep -Eq '/root/coral( |$)'; }"

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

var backendArgRe = regexp.MustCompile(`^(pty|tmux|keep)$`)

var archRe = regexp.MustCompile(`^(amd64|arm64)$`)

var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

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
	CmdStartDaemon: {template: "umask 077 && mkdir -p \"$HOME/" + InstallDir + "/data\" && { " + aliveTest + " || { bf=\"$HOME/" + InstallDir + "/backend\"; b=%[2]s; " +
		"if [ \"$b\" = keep ]; then b=$(cat \"$bf\" 2>/dev/null); case \"$b\" in pty|tmux) ;; *) if command -v tmux >/dev/null 2>&1; then b=tmux; else b=pty; fi;; esac; fi; " +
		"if [ \"$b\" = tmux ] && ! command -v tmux >/dev/null 2>&1; then exit 7; fi; printf %%s \"$b\" > \"$bf\"; s=; command -v setsid >/dev/null 2>&1 && s=setsid; " +
		"l=\"$HOME/" + InstallDir + "/coral.log\"; if [ \"$(wc -c < \"$l\" 2>/dev/null || echo 0)\" -gt 10485760 ]; then mv -f \"$l\" \"$l.1\"; fi; " +
		"P=\"$HOME/" + InstallDir + "/coral.pid\" C=\"$HOME/" + InstallDir + "/%[1]s/root/coral\" B=$b H=\"$HOME/" + InstallDir + "/data\" " +
		"nohup $s sh -c 'echo $$ > \"$P\"; exec \"$C\" --host 127.0.0.1 --port 8420 --no-browser --cloud-url off --backend \"$B\" --home \"$H\"' </dev/null >>\"$l\" 2>&1 & }; }", args: []*regexp.Regexp{versionRe, backendArgRe}},
	CmdEnsureInstanceID: {template: "umask 077 && mkdir -p \"$HOME/" + InstallDir + "\" && f=\"$HOME/" + InstallDir + "/instance-id\" && { [ -s \"$f\" ] || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > \"$f\"; } && cat \"$f\""},
	CmdReadAPIKey:       {template: "\"$HOME/" + InstallDir + "/%s/root/coral\" api-key --home \"$HOME/" + InstallDir + "/data\" 2>/dev/null", args: []*regexp.Regexp{versionRe}},
	CmdAcceptTerms:      {template: "\"$HOME/" + InstallDir + "/%s/root/coral\" accept-terms", args: []*regexp.Regexp{versionRe}},
	CmdStopDaemon:       {template: aliveTest + " && kill \"$(cat \"$HOME/" + InstallDir + "/coral.pid\")\" 2>/dev/null; true"},
	CmdStopTmux:         {template: "tmux kill-session -t =coral-server 2>/dev/null; true"},
	CmdRemoveInstalls:   {template: "cd \"$HOME/" + InstallDir + "\" 2>/dev/null && for d in [0-9]*; do [ -d \"$d\" ] && rm -rf -- \"$d\"; done; true"},
	CmdRemoveAll:        {template: "[ -n \"$HOME\" ] && rm -rf \"$HOME/" + InstallDir + "\""},
	CmdCheckStopped: {template: "if tmux has-session -t =coral-server 2>/dev/null; then exit 1; fi; out=$(ps -u \"$(id -u)\" -o args= 2>/dev/null) || exit 3; " +
		"if printf '%%s\\n' \"$out\" | grep -F -- \"$HOME/" + InstallDir + "/\" | grep -Eq '/root/coral( |$)'; then exit 2; fi; exit 0"},
	CmdCheckPort: {template: "if tmux has-session -t =coral-server 2>/dev/null; then exit 0; fi; if " + aliveTest + "; then exit 0; fi; [ -r /proc/net/tcp ] || exit 3; " +
		"if grep -Eqs '^ *[0-9]+: [0-9A-Fa-f]+:20E4 [0-9A-Fa-f:]+ 0A ' /proc/net/tcp /proc/net/tcp6; then exit 2; fi; exit 0"},
	CmdInstallOwnerSecret: {template: "\"$HOME/" + InstallDir + "/%s/root/coral\" hub-owner-secret --home \"$HOME/" + InstallDir + "/data\"", args: []*regexp.Regexp{versionRe}},
	CmdFreeKB:             {template: "df -Pk \"$HOME\" | awk 'NR==2 {print $4}'"},
	// The recorded sum goes FIRST: a re-unpack that is interrupted leaves no sum next to a half-written root, so the next run does not say "already installed". It is written last.
	CmdUnpack: {template: "umask 077 && cd \"$HOME/" + InstallDir + "/%[1]s\" && rm -f package.sha256 && rm -rf root && mkdir root && tar -xzf package.tar.gz --no-same-owner -C root && " +
		"{ sha256sum package.tar.gz 2>/dev/null || shasum -a 256 package.tar.gz; } | cut -d' ' -f1 > package.sha256", args: []*regexp.Regexp{versionRe}, timeout: 5 * time.Minute},
	CmdDownload: {template: "command -v curl >/dev/null 2>&1 || exit 6; umask 077 && cd \"$HOME/" + InstallDir + "/%[1]s\" && rm -f package.tar.gz && " +
		"{ curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-filesize 314572800 --connect-timeout 20 -o package.tar.gz " +
		"\"https://github.com/subgentic/coral/releases/download/v%[1]s/coral-linux-%[2]s-%[1]s.tar.gz\" || { rm -f package.tar.gz; exit 4; }; } && " +
		"got=$({ sha256sum package.tar.gz 2>/dev/null || shasum -a 256 package.tar.gz; } | cut -d' ' -f1) && { [ \"$got\" = '%[3]s' ] || { rm -f package.tar.gz; exit 5; }; }",
		args: []*regexp.Regexp{versionRe, archRe, sha256Re}, timeout: 10 * time.Minute},
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
	out := fmt.Sprintf(s.template, vals...)
	if strings.Contains(out, "%!") { // a stray % verb in a template (QA Engineer's MUST on #11429: %!s(MISSING) made the stop check always say "stopped"): never sent
		return "", fmt.Errorf("%w: the template for command %d is not well formed", ErrNotAllowed, c)
	}
	return out, nil
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
	// KnownHosts is the file host keys are checked in; empty means DefaultKnownHostsPath().
	KnownHosts string
	// Config is the owner's ssh config that the alias scan includes (ScanAlias); empty means DefaultConfigPath().
	Config string
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

// ConnectKind is why ssh could not connect or sign in, read from what ssh printed (exit 255). The Operator is shown a fixed sentence for the kind, never the text itself (it came from the network
// or the far side); the capped, cleaned text goes to the hub's log (#12027).
type ConnectKind string

const (
	KindOther   ConnectKind = "other"
	KindAuth    ConnectKind = "auth"    // Permission denied: the key or agent was not accepted
	KindTimeout ConnectKind = "timeout" // the connection or the command ran out of time
	KindRefused ConnectKind = "refused" // nothing listens on that address and port
	KindName    ConnectKind = "name"    // the name did not resolve
	KindRoute   ConnectKind = "route"   // no route, or the network is unreachable
	KindClosed  ConnectKind = "closed"  // the far side closed the connection during sign-in
)

// ConnectError is ErrConnect with its kind and the cleaned start of ssh's own message (for the log only). errors.Is(err, ErrConnect) holds.
type ConnectError struct {
	Kind   ConnectKind
	Stderr string
}

func (e *ConnectError) Error() string        { return "sshprov: could not connect: " + string(e.Kind) }
func (e *ConnectError) Is(target error) bool { return target == ErrConnect }

// classifyConnect reads ssh's stderr for the kind of failure.
func classifyConnect(stderr string) ConnectKind {
	l := strings.ToLower(stderr)
	switch {
	case strings.Contains(l, "permission denied"), strings.Contains(l, "too many authentication failures"):
		return KindAuth
	case strings.Contains(l, "timed out"):
		return KindTimeout
	case strings.Contains(l, "connection refused"):
		return KindRefused
	case strings.Contains(l, "could not resolve hostname"), strings.Contains(l, "name or service not known"), strings.Contains(l, "nodename nor servname"):
		return KindName
	case strings.Contains(l, "no route to host"), strings.Contains(l, "network is unreachable"):
		return KindRoute
	case strings.Contains(l, "connection closed by"), strings.Contains(l, "connection reset"), strings.Contains(l, "kex_exchange_identification"):
		return KindClosed
	}
	return KindOther
}

// ConnectSentence is the fixed sentence for a failed ssh run: the person sees it, never ssh's own text.
func ConnectSentence(err error) string {
	switch {
	case errors.Is(err, ErrHostKeyChanged):
		return "The host key has changed since you confirmed it. This may be a different computer. If you expected it, remove this computer's line from ssh_known_hosts in Coral's data folder, then run Set up again."
	case errors.Is(err, ErrHostKey):
		return "The hub does not have this computer's host key under the name ssh uses for it. Run Set up again and confirm the key it shows, or check the host name."
	}
	var ce *ConnectError
	if errors.As(err, &ce) {
		switch ce.Kind {
		case KindAuth:
			return "The computer refused the sign-in: this computer's SSH key or agent is not accepted there."
		case KindTimeout:
			return "The connection timed out."
		case KindRefused:
			return "The computer refused the connection. Is SSH running on that port?"
		case KindName:
			return "That host name could not be found."
		case KindRoute:
			return "There is no route to that computer."
		case KindClosed:
			return "The computer closed the connection while signing in."
		}
	}
	return "Could not connect."
}

// cleanStderr is the start of ssh's message for the log: control characters out, spaces folded, at most 300 characters.
func cleanStderr(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	// A ProxyCommand prints its own program's messages on ssh's stderr (a URL with a token, a session id): the text goes through the same redaction as session excerpts before it is kept, and a
	// redactor that refuses keeps nothing.
	red, err := secrets.Redactor().Text([]byte(s))
	if err != nil {
		return "(not shown: it could not be checked for secrets)"
	}
	s = string(red)
	if utf8.RuneCountInString(s) > 300 {
		s = string([]rune(s)[:300]) + "…"
	}
	return s
}

// sshOptions are on every ssh the hub starts: no prompt, no unknown host key, no forwarding of the hub user's agent or display, no command from the config.
// ClearAllForwardings does not stop -W, which is the one forward the stream target asks for.
var sshOptions = []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no", "-o", "LogLevel=ERROR",
	"-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none"}

// hostFileArgs make the host-key check the hub's own whatever the owner's ssh config says (#12027): a command-line -o wins over the config, so a host block with StrictHostKeyChecking=no and
// UserKnownHostsFile=/dev/null (Coder's) can neither turn the check off nor send it to a file that never holds the key the owner confirmed. No system-wide known_hosts, no key updates.
func (r Runner) hostFileArgs() []string {
	p := r.KnownHosts
	if p == "" {
		p = DefaultKnownHostsPath()
	}
	if p == "" {
		return nil
	}
	if strings.ContainsAny(p, " \t") {
		p = `"` + p + `"`
	}
	return []string{"-o", "UserKnownHostsFile=" + p, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no"}
}

// baseArgv is the options every hub ssh to t starts with: the fixed ones, the host-key file, then the target's own.
func (r Runner) baseArgv(t Target) []string {
	argv := append([]string{}, sshOptions...)
	argv = append(argv, r.hostFileArgs()...)
	argv = append(argv, controlArgs()...)
	return append(argv, t.Args()...)
}

const maxOutput = 64 << 10

// shQuote is s as one single-quoted word for the remote shell.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// minimalEnv is all ssh is given: the hub's own CORAL_* values and anything else in its environment never reach a user's SendEnv or ProxyCommand. SSH_AUTH_SOCK is the user's agent.
func minimalEnv() []string {
	env := []string{"LC_ALL=C"}
	// The Windows names are the ones ssh.exe needs to find the user's .ssh folder and to run (USERPROFILE, HOMEDRIVE and HOMEPATH, SystemRoot, USERNAME, TEMP and TMP); they are unset elsewhere, and
	// nothing of the hub's own (CORAL_*) is ever passed.
	for _, k := range []string{"HOME", "USER", "PATH", "SSH_AUTH_SOCK", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "SystemRoot", "TEMP", "TMP"} {
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
	argv := r.baseArgv(t)
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
			se := errOut.b.String()
			return res, &ConnectError{Kind: classifyConnect(se), Stderr: cleanStderr(se)}
		}
		return res, nil // the command ran and exited non-zero: the caller reads ExitCode (tmux absent is not an error)
	}
	if ctx.Err() != nil {
		return res, &ConnectError{Kind: KindTimeout, Stderr: cleanStderr(errOut.b.String())}
	}
	return res, runErr
}
