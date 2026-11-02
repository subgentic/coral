package sshprov

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseTargetAccepts(t *testing.T) {
	for in, want := range map[string]Target{
		"user@box.example.com":      {User: "user", Host: "box.example.com", Port: 22},
		"user@box.example.com:2222": {User: "user", Host: "box.example.com", Port: 2222},
		"_svc-1@10.0.0.7":           {User: "_svc-1", Host: "10.0.0.7", Port: 22},
		"u@[2001:db8::1]:2200":      {User: "u", Host: "2001:db8::1", Port: 2200},
		"u@[2001:db8::1]":           {User: "u", Host: "2001:db8::1", Port: 22},
	} {
		got, err := ParseTarget(in)
		if err != nil || got != want {
			t.Errorf("ParseTarget(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
}

func TestParseTargetRefusesWhatSSHOrAShellCouldRead(t *testing.T) {
	for _, in := range []string{
		"", "host", "@host", "user@", "user@-oProxyCommand=x", "-oProxyCommand=x@host", "user@host;rm", "user@host name", "user@host\n", "user@$(id)", "user@`id`",
		"user@host:0", "user@host:65536", "user@host:22x", "user@host:", "RICH@host", "user@ho_st", "user@-host", "user@host-", "user@2001:db8::1", "user@[fe80::1%eth0]",
		"user@[::1", "user@[1.2.3.4]", "user@host..com", "a b@host", "user@host/path", "user@host\x00", strings.Repeat("a", 40) + "@host", "user@" + strings.Repeat("a", 300),
	} {
		if got, err := ParseTarget(in); err == nil {
			t.Errorf("ParseTarget(%q) accepted %+v", in, got)
		} else if !errors.Is(err, ErrBadTarget) {
			t.Errorf("ParseTarget(%q): error is not ErrBadTarget: %v", in, err)
		}
	}
}

func TestDestinationAndArgsAreOneArgumentEach(t *testing.T) {
	tg, _ := ParseTarget("user@[2001:db8::1]:2200")
	if got := tg.Destination(); got != "user@2001:db8::1" {
		t.Errorf("Destination = %q", got)
	}
	if !reflect.DeepEqual(tg.Args(), []string{"-p", "2200"}) {
		t.Errorf("Args = %v", tg.Args())
	}
	a, err := FromAlias("build-box")
	if err != nil || a.Destination() != "build-box" || a.Args() != nil {
		t.Errorf("alias: %+v %v", a, err)
	}
	for _, bad := range []string{"-oProxyCommand=x", "a b", "a;b", "", "a/b", "*"} {
		if _, err := FromAlias(bad); err == nil {
			t.Errorf("FromAlias(%q) accepted", bad)
		}
	}
}

func TestConfigHostsListsConcreteNamesOnly(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config")
	body := "# my hosts\nHost *\n  ForwardAgent yes\nHost build-box ci.example.com\n  HostName 10.0.0.2\n  ProxyCommand sh -c 'touch " + dir + "/ran'\nHost *.corp !bad\nhost=lowercase-key\nHost -oProxyCommand=x\nMatch host foo exec \"touch " + dir + "/ran2\"\nInclude " + dir + "/other\nHost dup dup # comment\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other"), []byte("Host from-include\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ConfigHosts(p)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"build-box", "ci.example.com", "dup", "lowercase-key"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ConfigHosts = %v; want %v", got, want)
	}
	for _, f := range []string{"ran", "ran2"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			t.Errorf("reading the config ran something (%s)", f)
		}
	}
	if none, err := ConfigHosts(filepath.Join(dir, "missing")); err != nil || none != nil {
		t.Errorf("a missing config is an empty list: %v %v", none, err)
	}
}

func TestRemoteTextIsClosed(t *testing.T) {
	if _, err := remoteText(Command(99)); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("unknown command: %v", err)
	}
	if _, err := remoteText(CmdUname, "extra"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a command with no slot took an argument: %v", err)
	}
	if _, err := remoteText(CmdSha256); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a missing argument: %v", err)
	}
	if got, err := remoteText(CmdSha256, "0.9.1/coral.tar.gz"); err != nil || !strings.Contains(got, "sha256sum -- '0.9.1/coral.tar.gz'") {
		t.Errorf("good argument: %q %v", got, err)
	}
	for _, bad := range []string{"", "../x", "a/../b", "/etc/passwd", "a b", "a'b", "a;b", "a$(x)", "a`x`", "a\nb", ".hidden", "a/b/c/d/e/f", strings.Repeat("a", 70), "-rf"} {
		if _, err := remoteText(CmdSha256, bad); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("argument %q accepted", bad)
		}
	}
}

func TestRunBuildsOneFixedArgvAndNeverRelaxesHostKeyChecking(t *testing.T) {
	log := filepath.Join(t.TempDir(), "argv")
	ssh := newStandIn(t, "ssh", standCfg{Log: log, Stdout: "Linux x86_64\n"})
	tg, _ := ParseTarget("user@box.example.com:2222")
	hubKnown := filepath.Join(t.TempDir(), "ssh_known_hosts")
	res, err := Runner{SSH: ssh, KnownHosts: hubKnown}.Run(context.Background(), tg, CmdUname)
	if err != nil || strings.TrimSpace(res.Stdout) != "Linux x86_64" {
		t.Fatalf("Run = %+v, %v", res, err)
	}
	b, _ := os.ReadFile(log)
	argv := strings.Split(strings.TrimSpace(string(b)), "\n")
	joined := strings.Join(argv, " ")
	for _, want := range []string{"BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "-p 2222", "ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no", "RemoteCommand=none", "UserKnownHostsFile=" + hubKnown, "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv lacks %q: %v", want, argv)
		}
	}
	if strings.Contains(joined, "StrictHostKeyChecking=no") || strings.Contains(joined, "accept-new") {
		t.Errorf("host key checking was relaxed: %v", argv)
	}
	n := len(argv)
	if argv[n-3] != "--" || argv[n-2] != "user@box.example.com" || argv[n-1] != "sh -c 'uname -sm'" {
		t.Errorf("the tail of argv is not '-- destination text': %v", argv[n-3:])
	}
}

func TestRunRefusesBeforeConnectingWhenTheCommandIsNotAllowed(t *testing.T) {
	log := filepath.Join(t.TempDir(), "argv")
	ssh := newStandIn(t, "ssh", standCfg{Log: log})
	tg, _ := ParseTarget("user@box.example.com")
	if _, err := (Runner{SSH: ssh}).Run(context.Background(), tg, CmdSha256, "x'; rm -rf ~; '"); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(log); err == nil {
		t.Error("ssh was started for a command that is not allowed")
	}
}

func TestRunMapsExitCodes(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com")
	hk := newStandIn(t, "ssh", standCfg{Stderr: "Host key verification failed.\n", Exit: 255})
	if _, err := (Runner{SSH: hk}).Run(context.Background(), tg, CmdUname); !errors.Is(err, ErrHostKey) {
		t.Errorf("host key: %v", err)
	}
	cn := newStandIn(t, "ssh", standCfg{Stderr: "Permission denied (publickey).\n", Exit: 255})
	if _, err := (Runner{SSH: cn}).Run(context.Background(), tg, CmdUname); !errors.Is(err, ErrConnect) || errors.Is(err, ErrHostKey) {
		t.Errorf("connect: %v", err)
	}
	no := newStandIn(t, "ssh", standCfg{Exit: 1})
	if res, err := (Runner{SSH: no}).Run(context.Background(), tg, CmdHasTmux); err != nil || res.ExitCode != 1 {
		t.Errorf("tmux absent is a result, not an error: %+v %v", res, err)
	}
}

func TestRunCapsWhatItKeeps(t *testing.T) {
	ssh := newStandIn(t, "ssh", standCfg{BigOut: 300000})
	tg, _ := ParseTarget("user@box.example.com")
	res, err := Runner{SSH: ssh}.Run(context.Background(), tg, CmdUname)
	if err != nil || len(res.Stdout) != maxOutput {
		t.Errorf("kept %d bytes, err %v", len(res.Stdout), err)
	}
}

func TestRunGivesSSHAMinimalEnvironmentAndQuotesTheText(t *testing.T) {
	t.Setenv("CORAL_SECRET_THING", "leak")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	dir := t.TempDir()
	envFile := filepath.Join(dir, "env")
	p := newStandIn(t, "ssh", standCfg{EnvFile: envFile, TextFile: envFile + ".text"})
	tg, _ := ParseTarget("user@box.example.com")
	if _, err := (Runner{SSH: p}).Run(context.Background(), tg, CmdSha256, "a/b.tgz"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(envFile)
	if strings.Contains(string(b), "CORAL_") || strings.Contains(string(b), "leak") {
		t.Errorf("the hub's environment reached ssh:\n%s", b)
	}
	if !strings.Contains(string(b), "SSH_AUTH_SOCK=/tmp/agent.sock") || !strings.Contains(string(b), "LC_ALL=C") {
		t.Errorf("the agent or locale is missing:\n%s", b)
	}
	text, _ := os.ReadFile(envFile + ".text")
	q := `'\''a/b.tgz'\''`
	want := `sh -c 'cd "$HOME/.coral-server" && { sha256sum -- ` + q + ` 2>/dev/null || shasum -a 256 -- ` + q + `; }'`
	if string(text) != want {
		t.Errorf("remote text = %s; want %s", text, want)
	}
}

// What ssh is given is a short fixed list: the user's own names (also the ones ssh.exe needs on Windows) and never the hub's CORAL_* values; a pure check, no shell.
func TestMinimalEnvIsTheUsersNamesOnly(t *testing.T) {
	t.Setenv("CORAL_SECRET_THING", "leak")
	t.Setenv("USERPROFILE", `C:\Users\user`)
	t.Setenv("SystemRoot", `C:\Windows`)
	t.Setenv("AWS_SECRET_ACCESS_KEY", "leak2")
	env := minimalEnv()
	joined := strings.Join(env, "\n")
	for _, bad := range []string{"CORAL_", "AWS_", "leak"} {
		if strings.Contains(joined, bad) {
			t.Errorf("the environment carries %q:\n%s", bad, joined)
		}
	}
	for _, want := range []string{"LC_ALL=C", `USERPROFILE=C:\Users\user`, `SystemRoot=C:\Windows`} {
		if !strings.Contains(joined, want) {
			t.Errorf("the environment lacks %q:\n%s", want, joined)
		}
	}
}

// #12027: a failed connection says why, from ssh's own message, and keeps a cleaned, capped copy of it for the log; every kind is still ErrConnect.
func TestRunNamesWhyItCouldNotConnect(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com")
	for stderr, want := range map[string]ConnectKind{
		"user@box: Permission denied (publickey).\n":                       KindAuth,
		"ssh: connect to host box port 22: Connection timed out\n":         KindTimeout,
		"ssh: connect to host box port 22: Connection refused\n":           KindRefused,
		"ssh: Could not resolve hostname box: Name or service not known\n": KindName,
		"ssh: connect to host box port 22: No route to host\n":             KindRoute,
		"Connection closed by 10.0.0.5 port 22\n":                          KindClosed,
		"kex_exchange_identification: read: Connection reset by peer\n":    KindClosed,
		"something nobody has seen before\n":                               KindOther,
	} {
		ssh := newStandIn(t, "ssh", standCfg{Stderr: stderr, Exit: 255})
		_, err := Runner{SSH: ssh}.Run(context.Background(), tg, CmdUname)
		var ce *ConnectError
		if !errors.As(err, &ce) || ce.Kind != want || !errors.Is(err, ErrConnect) || errors.Is(err, ErrHostKey) {
			t.Errorf("%q: %v (want %s)", stderr, err, want)
		}
	}
	long := newStandIn(t, "ssh", standCfg{Stderr: "Permission denied \x1b[31m(publickey)\x1b[0m\n" + strings.Repeat("x", 1000) + "\n", Exit: 255})
	_, err := Runner{SSH: long}.Run(context.Background(), tg, CmdUname)
	var ce *ConnectError
	if !errors.As(err, &ce) || strings.ContainsAny(ce.Stderr, "\x1b\n") || len(ce.Stderr) > 310 {
		t.Errorf("the kept text is cleaned and capped: %q", ce)
	}
}

// #12027: a host block with StrictHostKeyChecking=no and UserKnownHostsFile=/dev/null (Coder's config-ssh writes one) must not decide the hub's host-key check: the command line wins over the
// config, so ssh -G reports OUR values for the argv the runner builds, for an alias and for a typed target.
func TestRunnerHostKeyCheckIsOursWhateverTheHostBlockSays(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh on this computer")
	}
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	known := filepath.Join(dir, "hub known hosts")
	if err := os.WriteFile(cfg, []byte("Host coder.ws\n  HostName coder.ws\n  User dev\n  ProxyCommand /bin/true\n  UserKnownHostsFile /dev/null\n  StrictHostKeyChecking no\n  GlobalKnownHostsFile /etc/ssh/ssh_known_hosts\n  UpdateHostKeys yes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias, err := FromAlias("coder.ws")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{KnownHosts: known}
	argv := append([]string{"-G", "-F", cfg}, r.baseArgv(alias)...)
	argv = append(argv, "--", alias.Destination())
	out, err := exec.Command(sshBin, argv...).Output()
	if err != nil {
		t.Fatalf("ssh -G: %v", err)
	}
	got := map[string]string{}
	for _, l := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(l, " "); ok {
			got[k] = strings.Trim(v, `"`)
		}
	}
	for k, want := range map[string]string{"stricthostkeychecking": "true", "userknownhostsfile": known, "globalknownhostsfile": "/dev/null", "updatehostkeys": "false"} {
		if got[k] != want {
			t.Errorf("%s = %q, want %q (the host block's value won)", k, got[k], want)
		}
	}
}

// effectiveSSH is what ssh -G says it would use for argv under the config at cfg.
func effectiveSSH(t *testing.T, sshBin, cfg string, argv []string, dest string) map[string]string {
	t.Helper()
	full := append([]string{"-G", "-F", cfg}, argv...)
	full = append(full, "--", dest)
	out, err := exec.Command(sshBin, full...).Output()
	if err != nil {
		t.Fatalf("ssh -G: %v", err)
	}
	got := map[string]string{}
	for _, l := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(l, " "); ok {
			got[k] = strings.Trim(v, `"`)
		}
	}
	return got
}

// #12031 (Security's point 1): every hub ssh that talks to a host (the runner and the stream) says ForwardAgent=no, ForwardX11=no and ClearAllForwardings=yes, whatever the host block says;
// read back with ssh -G on a block that asks for all three.
func TestHubSshNeverForwardsAnythingWhateverTheHostBlockSays(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh on this computer")
	}
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	if err := os.WriteFile(cfg, []byte("Host box\n  HostName box.example.com\n  User dev\n  ForwardAgent yes\n  ForwardX11 yes\n  ForwardX11Trusted yes\n  ClearAllForwardings no\n  LocalForward 9999 localhost:9999\n  RemoteCommand uname\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias, err := FromAlias("box")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{KnownHosts: filepath.Join(dir, "kh")}
	st, err := NewStreamTarget(r, alias, 8420, "k")
	if err != nil {
		t.Fatal(err)
	}
	for name, argv := range map[string][]string{"runner": r.baseArgv(alias), "stream": st.argv()} {
		got := effectiveSSH(t, sshBin, cfg, argv, alias.Destination())
		for k, want := range map[string]string{"forwardagent": "no", "forwardx11": "no", "clearallforwardings": "yes", "stricthostkeychecking": "true"} {
			if got[k] != want {
				t.Errorf("%s: %s = %q, want %q", name, k, got[k], want)
			}
		}
		if got["remotecommand"] == "uname" || got["localforward"] != "" {
			t.Errorf("%s: the host block's command or forward got through: %v", name, got)
		}
	}
}

// #12031: the host-key scan's ssh offers no credential and forwards nothing: no authentication but none, no public key, no agent, only the identities the config names are not tried, and a fresh
// temporary known_hosts with the check off for this one connection (never the owner's file).
func TestScanAliasArgvOffersNoCredentialAndForwardsNothing(t *testing.T) {
	log := filepath.Join(t.TempDir(), "argv")
	ssh := newStandIn(t, "ssh", standCfg{Log: log, Exit: 255})
	alias, err := FromAlias("box")
	if err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(t.TempDir(), "config")
	_ = os.WriteFile(cfg, []byte("Host box\n  HostName box.example.com\n"), 0o600)
	_, _ = Runner{SSH: ssh, Config: cfg}.ScanAlias(context.Background(), alias) // no key is stored by the stand-in: an error is expected
	b, _ := os.ReadFile(log)
	joined := " " + strings.Join(strings.Split(strings.TrimSpace(string(b)), "\n"), " ") + " "
	for _, want := range []string{"PreferredAuthentications=none", "PubkeyAuthentication=no", "IdentityAgent=none", "IdentitiesOnly=yes", "BatchMode=yes", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes",
		"StrictHostKeyChecking=no", "GlobalKnownHostsFile=/dev/null", "HashKnownHosts=no", "RemoteCommand=none"} {
		if !strings.Contains(joined, " "+want+" ") {
			t.Errorf("the scan's argv lacks %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "StrictHostKeyChecking=yes") || strings.Contains(joined, ".ssh/known_hosts") {
		t.Errorf("the scan checks nothing against the owner's file and keeps no strict option: %s", joined)
	}
	if !strings.Contains(joined, " -F ") || !strings.Contains(joined, "UserKnownHostsFile=") {
		t.Errorf("the scan uses its own config and its own known_hosts: %s", joined)
	}
}

// #12031 (Security's SHOULD on #12027): the kept ssh text is redacted like a session excerpt: a ProxyCommand's token or bearer string on stderr is masked, and the cut is on a character boundary.
func TestCleanStderrMasksSecretsAndCutsOnACharacter(t *testing.T) {
	token := "ghp_" + strings.Repeat("a1B2c3D4e5", 4)
	got := cleanStderr("coder: open https://coder.example.com/login?x=1\nAuthorization: Bearer " + token + "\ntoken=" + token + "\n")
	if strings.Contains(got, token) || strings.Contains(got, strings.Repeat("a1B2c3D4e5", 3)) {
		t.Errorf("a secret is in the kept text: %q", got)
	}
	if !strings.Contains(got, "coder.example.com") {
		t.Errorf("the rest is kept: %q", got)
	}
	long := cleanStderr(strings.Repeat("é", 400))
	if !utf8.ValidString(long) || utf8.RuneCountInString(long) > 301 {
		t.Errorf("the cut is on a character and at most 300 of them: %d runes, valid=%v", utf8.RuneCountInString(long), utf8.ValidString(long))
	}
}

// #12031 (QA's SHOULD): the stream ssh (-W, the one forward the hub allows) carries the same host-file arguments as the runner: the hub's own file, no system known_hosts, no key updates.
func TestStreamSshPinsTheHubsHostKeyFileAndItsOneForward(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com:2222")
	known := filepath.Join(t.TempDir(), "ssh_known_hosts")
	st, err := NewStreamTarget(Runner{KnownHosts: known}, tg, 8420, "k")
	if err != nil {
		t.Fatal(err)
	}
	joined := " " + strings.Join(st.argv(), " ") + " "
	for _, want := range []string{"UserKnownHostsFile=" + known, "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "-W 127.0.0.1:8420", "-p 2222"} {
		if !strings.Contains(joined, " "+want+" ") {
			t.Errorf("the stream's argv lacks %q: %s", want, joined)
		}
	}
	if i, j := strings.Index(joined, "UserKnownHostsFile="), strings.Index(joined, " -- "); i < 0 || j < 0 || i > j {
		t.Errorf("the host-file arguments must come before the target's own and the --: %s", joined)
	}
}
