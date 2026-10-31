package sshprov

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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

// fakeSSH writes a script that records its argv one per line and acts as the remote.
func fakeSSH(t *testing.T, body string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '" + log + "'; done\n" + body + "\n"
	p := filepath.Join(dir, "ssh")
	if err := os.WriteFile(p, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return p, log
}

func TestRunBuildsOneFixedArgvAndNeverRelaxesHostKeyChecking(t *testing.T) {
	needShell(t)
	ssh, log := fakeSSH(t, "echo Linux x86_64")
	tg, _ := ParseTarget("user@box.example.com:2222")
	res, err := Runner{SSH: ssh}.Run(context.Background(), tg, CmdUname)
	if err != nil || strings.TrimSpace(res.Stdout) != "Linux x86_64" {
		t.Fatalf("Run = %+v, %v", res, err)
	}
	b, _ := os.ReadFile(log)
	argv := strings.Split(strings.TrimSpace(string(b)), "\n")
	joined := strings.Join(argv, " ")
	for _, want := range []string{"BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "-p 2222", "ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no", "RemoteCommand=none"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv lacks %q: %v", want, argv)
		}
	}
	if strings.Contains(joined, "StrictHostKeyChecking=no") || strings.Contains(joined, "accept-new") || strings.Contains(joined, "UserKnownHostsFile") {
		t.Errorf("host key checking was relaxed: %v", argv)
	}
	n := len(argv)
	if argv[n-3] != "--" || argv[n-2] != "user@box.example.com" || argv[n-1] != "sh -c 'uname -sm'" {
		t.Errorf("the tail of argv is not '-- destination text': %v", argv[n-3:])
	}
}

func TestRunRefusesBeforeConnectingWhenTheCommandIsNotAllowed(t *testing.T) {
	needShell(t)
	ssh, log := fakeSSH(t, "true")
	tg, _ := ParseTarget("user@box.example.com")
	if _, err := (Runner{SSH: ssh}).Run(context.Background(), tg, CmdSha256, "x'; rm -rf ~; '"); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(log); err == nil {
		t.Error("ssh was started for a command that is not allowed")
	}
}

func TestRunMapsExitCodes(t *testing.T) {
	needShell(t)
	tg, _ := ParseTarget("user@box.example.com")
	hk, _ := fakeSSH(t, "echo 'Host key verification failed.' >&2; exit 255")
	if _, err := (Runner{SSH: hk}).Run(context.Background(), tg, CmdUname); !errors.Is(err, ErrHostKey) {
		t.Errorf("host key: %v", err)
	}
	cn, _ := fakeSSH(t, "echo 'Permission denied (publickey).' >&2; exit 255")
	if _, err := (Runner{SSH: cn}).Run(context.Background(), tg, CmdUname); !errors.Is(err, ErrConnect) || errors.Is(err, ErrHostKey) {
		t.Errorf("connect: %v", err)
	}
	no, _ := fakeSSH(t, "exit 1")
	if res, err := (Runner{SSH: no}).Run(context.Background(), tg, CmdHasTmux); err != nil || res.ExitCode != 1 {
		t.Errorf("tmux absent is a result, not an error: %+v %v", res, err)
	}
}

func TestRunCapsWhatItKeeps(t *testing.T) {
	needShell(t)
	ssh, _ := fakeSSH(t, "yes x | head -c 300000")
	tg, _ := ParseTarget("user@box.example.com")
	res, err := Runner{SSH: ssh}.Run(context.Background(), tg, CmdUname)
	if err != nil || len(res.Stdout) != maxOutput {
		t.Errorf("kept %d bytes, err %v", len(res.Stdout), err)
	}
}

func TestRunGivesSSHAMinimalEnvironmentAndQuotesTheText(t *testing.T) {
	needShell(t)
	t.Setenv("CORAL_SECRET_THING", "leak")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	dir := t.TempDir()
	envFile := filepath.Join(dir, "env")
	script := "#!/bin/sh\nenv > '" + envFile + "'\nfor a in \"$@\"; do last=\"$a\"; done\nprintf '%s' \"$last\" > '" + envFile + ".text'\n"
	p := filepath.Join(dir, "ssh")
	if err := os.WriteFile(p, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
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
