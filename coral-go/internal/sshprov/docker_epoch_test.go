//go:build sshdocker

package sshprov

// The SSH setup against REAL sshd (#170): containers are the far computers, the real ssh, ssh-keyscan and ssh-keygen of the machine run against them, and a real ProxyJump sits between. Opt-in and for
// epoch only (tests/ssh_docker/run_on_epoch.sh): it needs docker, builds a linux coral, and removes everything it made, by name, on exit. Run: SSHDOCKER=1 go test -tags sshdocker -run TestSSHDocker -p 1 -v
//
// Nothing here is a real credential: one ed25519 key made for the run, no agent (SSH_AUTH_SOCK is unset), the containers are on a private docker network with no published port, and the data folders
// are the containers' own. The release download and Sigstore check have their own tests: here the package is the linux build of this tree, handed to the installer as a local file.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/license"
	terms "github.com/subgentic/coral/pkg/license"
)

const dkVersion = "2.0.99"

type dkFix struct {
	t        *testing.T
	run      string
	home     string
	known    string
	pkg      []byte
	jumpIP   string
	farIP    string
	r        Runner
	farAlias map[string]string
}

func dkRandID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// docker runs one docker command and returns its output; a failure stops the test with it.
func (f *dkFix) docker(args ...string) string {
	f.t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		f.t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (f *dkFix) dockerTry(args ...string) (string, error) {
	out, err := exec.Command("docker", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func dkFixture(t *testing.T) *dkFix {
	if os.Getenv("SSHDOCKER") != "1" {
		t.Skip("opt-in: SSHDOCKER=1 (epoch only, needs docker)")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker is not available")
	}
	f := &dkFix{t: t, run: "sshdk-" + dkRandID(), farAlias: map[string]string{}}
	tmp := t.TempDir()
	f.home = filepath.Join(tmp, "home")
	sshDir := filepath.Join(f.home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	f.known = filepath.Join(sshDir, "known_hosts")

	// everything made is named with the run id and removed by that exact name, on success or failure
	t.Cleanup(func() {
		for _, c := range []string{f.run + "-jump", f.run + "-far"} {
			_, _ = f.dockerTry("rm", "-f", c)
		}
		_, _ = f.dockerTry("network", "rm", f.run+"-net")
		_, _ = f.dockerTry("rmi", "-f", f.run+"-img")
	})

	// the package: the linux build of this tree, as the release asset the installer would have fetched
	root := filepath.Join(tmp, "pkgroot")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-tags", "dev fts5", "-o", filepath.Join(root, "coral"), "../../cmd/coral")
	build.Env = os.Environ()
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build coral: %v\n%s", err, out)
	}
	tarOut, err := exec.Command("tar", "-czf", "-", "-C", root, "coral").Output()
	if err != nil {
		t.Fatalf("tar: %v", err)
	}
	f.pkg = tarOut

	// the key of this run, and the image: sshd, tmux and three users (alice and bob are the two users of one far computer)
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f.run, "-f", filepath.Join(sshDir, "id_run")).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	ctxDir := filepath.Join(tmp, "image")
	if err := os.MkdirAll(ctxDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pub, _ := os.ReadFile(filepath.Join(sshDir, "id_run.pub"))
	if err := os.WriteFile(filepath.Join(ctxDir, "id_run.pub"), pub, 0o644); err != nil {
		t.Fatal(err)
	}
	dockerfile := `FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server tmux ca-certificates procps && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN for u in alice bob jumper; do useradd -m -s /bin/bash -p '*' $u && mkdir -p /home/$u/.ssh; done
COPY id_run.pub /tmp/k.pub
RUN for u in alice bob jumper; do cp /tmp/k.pub /home/$u/.ssh/authorized_keys && chown -R $u:$u /home/$u/.ssh && chmod 700 /home/$u/.ssh && chmod 600 /home/$u/.ssh/authorized_keys; done
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o LogLevel=VERBOSE -o AllowTcpForwarding=yes"]
`
	if err := os.WriteFile(filepath.Join(ctxDir, "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		t.Fatal(err)
	}
	f.docker("build", "-q", "-t", f.run+"-img", ctxDir)
	f.docker("network", "create", f.run+"-net")
	for _, c := range []string{"jump", "far"} {
		f.docker("run", "-d", "--name", f.run+"-"+c, "--network", f.run+"-net", f.run+"-img")
	}
	ip := func(c string) string {
		return f.docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", f.run+"-"+c)
	}
	f.jumpIP, f.farIP = ip("jump"), ip("far")
	for _, c := range []string{f.jumpIP, f.farIP} {
		if c == "" {
			t.Fatal("a container has no address")
		}
	}

	// the user's SSH config for the run: the far computer is only reached through the jump
	// ssh finds ~/.ssh/config through the passwd entry, not $HOME, so the run's config is given with -F by a one-line wrapper (a ProxyJump's own ssh gets the same -F from its parent, as the user's config would
	// reach it). The known_hosts file is in the config, as a user's is, so the inner ssh of the jump reads it too.
	cfg := "Host *\n  IdentityFile " + filepath.Join(sshDir, "id_run") + "\n  IdentitiesOnly yes\n  UserKnownHostsFile " + f.known + "\n\n" +
		"Host jump\n  HostName " + f.jumpIP + "\n  User jumper\n\n" +
		"Host far-alice\n  HostName " + f.farIP + "\n  User alice\n  ProxyJump jump\n\n" +
		"Host far-bob\n  HostName " + f.farIP + "\n  User bob\n  ProxyJump jump\n"
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", f.home)
	t.Setenv("SSH_AUTH_SOCK", "")
	os.Unsetenv("SSH_AUTH_SOCK")
	wrapper := filepath.Join(tmp, "ssh-with-config")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec ssh -F '"+filepath.Join(sshDir, "config")+"' \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	f.r = Runner{SSH: wrapper, Timeout: 60 * time.Second}

	// wait for both sshd (a few seconds after the container starts)
	for _, c := range []string{"jump", "far"} {
		deadline := time.Now().Add(60 * time.Second)
		for {
			out, _ := f.dockerTry("exec", f.run+"-"+c, "sh", "-c", "pgrep -x sshd >/dev/null && ls /etc/ssh/ssh_host_ed25519_key >/dev/null && echo ready")
			if strings.Contains(out, "ready") {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("sshd of %s did not come up:\n%s", c, f.docker("logs", f.run+"-"+c))
			}
			time.Sleep(300 * time.Millisecond)
		}
	}
	return f
}

func (f *dkFix) exec(user, container string, cmd string) (string, error) {
	return f.dockerTry("exec", "-u", user, f.run+"-"+container, "sh", "-c", cmd)
}

func (f *dkFix) logs(container string) string {
	out, _ := f.dockerTry("logs", f.run+"-"+container)
	return out
}

func termsFor() []byte {
	b, _ := json.Marshal(map[string]string{"version": license.EULAVersion, "sha256": terms.EULADigest(), "by": "hub-owner@docker-test"})
	return b
}

func (f *dkFix) installer() Installer {
	sum := sha256.Sum256(f.pkg)
	return Installer{
		Runner:  f.r,
		Version: dkVersion,
		TempDir: f.t.TempDir(),
		Download: func(_ context.Context, url, dst string, _ int64) error {
			content := []byte("x")
			if strings.HasSuffix(url, ".tar.gz") {
				content = f.pkg
			}
			return os.WriteFile(dst, content, 0o600)
		},
		RunHelper: func(context.Context, string, string, string) (string, error) { return hex.EncodeToString(sum[:]), nil },
		Progress:  func(step, state, detail string) { f.t.Logf("  [%s] %s: %s", step, state, detail) },
	}
}

func TestSSHDocker(t *testing.T) {
	f := dkFixture(t)
	ctx := context.Background()

	// ── ProxyJump: the scan names the jump AND the far computer, nothing else; both are trusted; only then does anything connect
	var aliceTarget Target
	t.Run("proxyjump_scan_trust_connect", func(t *testing.T) {
		tg, err := FromAlias("far-alice")
		if err != nil {
			t.Fatal(err)
		}
		aliceTarget = tg
		if _, err := f.r.Run(ctx, tg, CmdUname); !errors.Is(err, ErrHostKey) {
			t.Logf("  DIAG plain:\n%s", f.raw("far-alice"))
			t.Logf("  DIAG -v (proxy and host key lines):\n%s", grepLines(f.raw("far-alice", "-v"), "proxy", "Proxy", "known_hosts", "StrictHost", "Host key", "host key", "verification", "denied", "Connection closed", "Permission"))
			t.Fatalf("before any key is trusted, ssh must refuse on the host key: %v", err)
		}
		keys, err := f.r.ScanAlias(ctx, tg)
		if err != nil {
			t.Fatalf("ScanAlias through the jump: %v", err)
		}
		hosts := map[string]bool{}
		for _, k := range keys {
			hosts[k.Host] = true
			t.Logf("  key %s %s %s", k.Host, k.Type, k.Fingerprint)
		}
		if len(hosts) != 2 || !hosts[f.jumpIP] || !hosts[f.farIP] {
			t.Fatalf("the scan must name the jump (%s) and the far computer (%s) and nothing else: %v", f.jumpIP, f.farIP, hosts)
		}
		// the fingerprints shown are the real ones: compare with the container's own
		for _, c := range []struct{ name, ip string }{{"jump", f.jumpIP}, {"far", f.farIP}} {
			want := f.docker("exec", f.run+"-"+c.name, "ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub")
			found := false
			for _, k := range keys {
				if k.Host == c.ip && k.Type == "ssh-ed25519" && strings.Contains(want, k.Fingerprint) {
					found = true
				}
			}
			if !found {
				t.Errorf("the ed25519 fingerprint of %s is not in the scan (container says %q)", c.name, want)
			}
		}
		for _, k := range keys {
			if err := Trust(f.known, k); err != nil {
				t.Fatalf("Trust: %v", err)
			}
		}
		res, err := f.r.Run(ctx, tg, CmdUname)
		if err != nil || strings.TrimSpace(res.Stdout) != "Linux x86_64" {
			t.Fatalf("uname through the jump = %+v, %v", res, err)
		}
		// the far computer saw the jump, not the hub
		if lg := f.logs("far"); !strings.Contains(lg, "Accepted publickey for alice from "+f.jumpIP) {
			t.Errorf("the far sshd did not see the connection coming from the jump (%s):\n%s", f.jumpIP, lg)
		}
	})

	// ── the two users: each sets up their own Coral on the same computer
	type user struct{ alias, name string }
	users := []user{{"far-alice", "alice"}, {"far-bob", "bob"}}
	keysOf := map[string]string{}
	started := map[string]bool{}
	for _, u := range users {
		u := u
		t.Run("setup_"+u.name, func(t *testing.T) {
			tg, _ := FromAlias(u.alias)
			if u.name == "bob" { // the same computer, so its keys are known; a second scan adds nothing
				keys, err := f.r.ScanAlias(ctx, tg)
				if err != nil {
					t.Fatal(err)
				}
				for _, k := range keys {
					if err := Trust(f.known, k); err != nil {
						t.Fatalf("a key already trusted for the same computer must not conflict: %v", err)
					}
				}
			}
			in := f.installer()
			sum, err := in.Install(ctx, tg, ArchAMD64)
			if err != nil {
				t.Fatalf("Install as %s: %v", u.name, err)
			}
			t.Logf("  installed, package sha256 %s", sum)
			id, err := f.r.EnsureInstanceID(ctx, tg)
			if err != nil {
				t.Fatalf("EnsureInstanceID: %v", err)
			}
			t.Logf("  instance id of %s: %s", u.name, id)
			keysOf["id-"+u.name] = id
			if err := f.r.AcceptTerms(ctx, tg, dkVersion, termsFor()); err != nil {
				t.Fatalf("AcceptTerms: %v", err)
			}
			if err := f.r.StartTmux(ctx, tg, dkVersion); err != nil {
				t.Fatalf("StartTmux: %v", err)
			}
			started[u.name] = true
			key, err := f.r.ReadAPIKey(ctx, tg, dkVersion)
			if err != nil {
				t.Logf("  FINDING: ReadAPIKey for %s failed after a start: %v", u.name, err)
				t.Logf("  tmux sessions of %s: %s", u.name, firstOut(f.exec(u.name, "far", "tmux ls 2>&1")))
				if u.name == "alice" {
					t.Fatal("the first user's Coral did not start")
				}
				return
			}
			keysOf["key-"+u.name] = key
			// what the hub would do next: ask the new server for its health through the stream (ssh -W through the jump to the far loopback)
			st, err := NewStreamTarget(f.r, tg, 8420, key)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			req, _ := http.NewRequest("GET", "http://x.invalid/api/health", nil)
			cctx, cancel := context.WithTimeout(ctx, 40*time.Second)
			defer cancel()
			resp, err := (&http.Client{Transport: st}).Do(req.WithContext(cctx))
			if err != nil {
				t.Logf("  FINDING: health through the stream for %s: %v", u.name, err)
				return
			}
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			resp.Body.Close()
			t.Logf("  health for %s through ssh -W via the jump: HTTP %d %s", u.name, resp.StatusCode, bytes.TrimSpace(body))
			if u.name == "alice" && resp.StatusCode != 200 {
				t.Errorf("the first user's Coral did not answer health with its own key: %d", resp.StatusCode)
			}
		})
	}

	// ── what the two users share and what they must not
	t.Run("two_users_are_separate", func(t *testing.T) {
		if keysOf["id-alice"] == "" || keysOf["id-bob"] == "" {
			t.Skip("a setup did not get as far as an instance id")
		}
		if keysOf["id-alice"] == keysOf["id-bob"] {
			t.Errorf("both users got the same instance id %s", keysOf["id-alice"])
		}
		for _, u := range users {
			if out, err := f.exec(u.name, "far", "stat -c '%a %U' ~/.coral-server ~/.coral-server/data ~/.coral-server/instance-id ~/.coral-server/data/api_key 2>&1"); err != nil {
				t.Logf("  %s: stat: %s", u.name, out)
			} else {
				t.Logf("  %s modes:\n%s", u.name, out)
				for _, l := range strings.Split(out, "\n") {
					if f := strings.Fields(l); len(f) > 0 && len(f[0]) == 3 && f[0][1:] != "00" {
						t.Errorf("%s: %q is readable by others", u.name, l)
					}
				}
			}
		}
		if out, err := f.exec("bob", "far", "cat /home/alice/.coral-server/data/api_key 2>&1"); err == nil {
			t.Errorf("bob could read alice's API key: %q", out)
		}
		sessions := func(u string) string { out, _ := f.exec(u, "far", "tmux ls 2>&1"); return strings.TrimSpace(out) }
		t.Logf("  tmux of alice: %s", sessions("alice"))
		t.Logf("  tmux of bob:   %s", sessions("bob"))
		listeners, _ := f.exec("root", "far", "grep -c ' 0A ' /proc/net/tcp; awk 'NR>1 && $4==\"0A\" {print $2}' /proc/net/tcp")
		t.Logf("  listening sockets in the far computer (hex local address; 20E4 is port 8420):\n%s", listeners)
	})

	// ── a stop by one user leaves the other alone
	t.Run("stop_alice_leaves_bob", func(t *testing.T) {
		if !started["alice"] || !started["bob"] {
			t.Skip("both users need to have started")
		}
		before, _ := f.exec("bob", "far", "tmux has-session -t =coral-server 2>&1 && echo alive")
		err := f.r.StopAndConfirm(ctx, aliceTarget)
		after, _ := f.exec("bob", "far", "tmux has-session -t =coral-server 2>&1 && echo alive")
		t.Logf("  bob before: %q, StopAndConfirm(alice) = %v, bob after: %q", firstOut(before, nil), err, firstOut(after, nil))
		if strings.Contains(before, "alive") && !strings.Contains(after, "alive") {
			t.Errorf("alice's stop ended bob's session")
		}
		if lg, _ := f.exec("alice", "far", "tmux has-session -t =coral-server 2>&1 && echo alive"); strings.Contains(lg, "alive") {
			t.Errorf("alice's own session is still there after a stop that returned %v", err)
		}
	})

	// ── a changed jump key refuses before the far computer is touched
	t.Run("changed_jump_key_refuses", func(t *testing.T) {
		tg, _ := FromAlias("far-bob")
		beforeAccepts := strings.Count(f.logs("far"), "Accepted publickey")
		f.docker("exec", f.run+"-jump", "sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A && pkill -HUP -x sshd")
		time.Sleep(500 * time.Millisecond)
		_, err := f.r.Run(ctx, tg, CmdUname)
		if !errors.Is(err, ErrHostKey) {
			t.Errorf("a changed jump key must refuse as a host key problem, got %v", err)
		}
		if after := strings.Count(f.logs("far"), "Accepted publickey"); after != beforeAccepts {
			t.Errorf("the far computer got a connection (%d -> %d) although the jump's key changed", beforeAccepts, after)
		}
	})
}

// raw runs the machine's own ssh the way the runner does (strict, batch) and returns everything it printed, for a failure that the runner reports only as "could not connect".
func (f *dkFix) raw(alias string, extra ...string) string {
	args := append([]string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"}, extra...)
	args = append(args, "--", alias, "true")
	cmd := exec.Command(f.r.SSH, args...)
	cmd.Env = minimalEnv()
	out, err := cmd.CombinedOutput()
	return "ssh " + strings.Join(args, " ") + " -> " + func() string {
		if err != nil {
			return err.Error()
		}
		return "ok"
	}() + "\n" + string(out)
}

func firstOut(s string, _ error) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " ..."
	}
	return s
}

func grepLines(s string, subs ...string) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		for _, sub := range subs {
			if strings.Contains(l, sub) {
				out = append(out, l)
				break
			}
		}
	}
	return strings.Join(out, "\n")
}
