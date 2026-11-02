package machinelaunch

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// The instance's cloud-init user-data (#9973, design note #9934 section 3): a stock Ubuntu LTS image, no image of ours. In order: a user `coral` with no password and no sudo, reachable over SSH by ONE public
// key only (the launch's own, made for it and thrown away after); the few packages Coral needs; the firewall (deny incoming but SSH for the launch: the machine connects OUT to Coral Hub); the Coral release for the
// pinned version with its SHA-256 checked against the release's SHA256SUMS.txt before anything is installed; and the Coral service as coral, on loopback only, which starts only when the launcher has put the Hub's
// one-time credential in its tmpfs file. That is ONE shell step that stops at the first failure, so Coral never starts if a download or a checksum fails.
//
// It holds NO credential and no secret of the person's (#10917, coral-hub Security's ruling: user-data stays readable from the droplet's metadata service for the droplet's whole life): the Hub's one-time credential
// is written to /run/coral/bootstrap.d/credential over SSH, standard input, AFTER the launcher has checked the droplet's host key against a pin it made in advance, and never touches user-data, a command line or a
// log. When the launcher is done (or after bootstrapWindow if it never comes), a root step stops sshd, closes port 22 and removes the host key and the launch key, enables Coral for the next boot and installs the
// agent CLIs (slow, and not needed to enroll). Every value that goes into a command is checked against a pattern first: nothing a caller passes is ever quoted into the shell, it is refused unless it is already safe.

// UserDataSpec is what BuildUserData needs.
type UserDataSpec struct {
	// ClientPublicKey is the launch's own SSH public key (an ed25519 authorized_keys line): the only key that can log in as coral, made for this launch and discarded with it. The matching private key never
	// leaves the launcher. There is no Hub credential here: it goes over SSH (#10917).
	ClientPublicKey string
	// MaxMode is the most Coral Hub may do on the machine: view, interact or launch. Empty is view.
	MaxMode string
	// CoralVersion is the release to install, x.y.z (no "v"). Required.
	CoralVersion string
	// CoralDigests are the SHA-256 digests of that release's Linux tarballs, pinned by the CLI (PinnedReleaseDigests) or given by the person. The machine checks its download against these and nothing it fetches
	// itself (#10919). Required.
	CoralDigests ReleaseDigests
	// Agents are the agent CLIs to install: "name@version" for the npm-installed ones (claude, codex, pi), which must be pinned; "agy@sha256:<64 hex>" for Antigravity's installer, which takes no
	// version: the installer script is fetched to a file, checked against that SHA-256 and only then run, and it runs only when this says so. Every installer fetched on the machine is pinned this
	// way, none is piped into a shell. The names come from the one table of CLIs (internal/agent).
	Agents []string
	// HostPrivateKey and HostPublicKey are the SINGLE-USE ed25519 host key pair the machine presents, which the launcher pinned in advance (coral-hub Security's ruling on #10917: sshd needs the private half, and the
	// provider has no console output to read a machine-made key from). It is the one secret in the user-data: it proves the machine's identity to the launcher for the length of the launch, and the finish step on the
	// machine stops and masks sshd and deletes it. HostPrivateKey is the OpenSSH PEM, HostPublicKey its authorized_keys line; they must be one pair.
	HostPrivateKey, HostPublicKey string
	// AllowSSHFrom is the address (an IP or a CIDR) the one open port, SSH, accepts connections from: the launcher's. It does not replace the host-key pin; it narrows who can even try (coral-hub Security).
	AllowSSHFrom string
	// HubURL is Coral Hub's origin, https only. Empty is the production Coral Hub.
	HubURL string
}

// DefaultHubURL is the production Coral Hub.
const DefaultHubURL = "https://app.coralhub.dev"

// coralRepo is the GitHub repository Coral releases are downloaded from. (internal/updater/verify has the same constant but is linked only into the updater, never into coral: a test keeps the two equal.)
const coralRepo = "subgentic/coral"

var (
	sha256PinRe = regexp.MustCompile(`^sha256:([0-9a-f]{64})$`)
	installerRe = regexp.MustCompile(`^https://[a-z0-9]([a-z0-9.-]{0,60}[a-z0-9])?(/[A-Za-z0-9._-]{1,64}){1,6}$`)
)

// bootstrapWindow is how long the machine waits for its launcher before it closes SSH and goes on without one (a launch that died between the create and the end of its delivery).
const bootstrapWindow = "20min"

var (
	versionRe    = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`)
	pinRe        = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z.]{1,40})?$`)
	hubURLRe     = regexp.MustCompile(`^https://[a-z0-9]([a-z0-9.-]{0,80}[a-z0-9])?(:[0-9]{1,5})?$`)
	npmPackageRe = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
)

// agentInstallCommand is the install command of an agent type's CLI, from the one table (agent.GetCLIInfo): the npm ones are rebuilt with the pinned version, never copied.
type agentInstall struct {
	Name    string
	Binary  string
	Command string // the npm install command, rebuilt with the pinned version (empty for agy)
	Package string // the npm package name without a version (empty for agy): what a failed install removes
	AsCoral bool   // agy: its installer script, checked against Hash, run as coral
	Pinned  string // the version, or sha256:<hex> for agy
	URL     string // agy: the installer's URL, from the table
	Hash    string // agy: the installer's SHA-256 (64 hex)
}

// agentBinaryRe is what an agent's program name may be: lower-case letters, digits, hyphen and underscore, starting with a letter, at most 32 long (no slash, dot, dot-dot, leading dash, whitespace or control character).
var agentBinaryRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// reservedAgentNames are programs the install and the machine itself use: an agent may never be linked over one.
var reservedAgentNames = []string{
	"sh", "bash", "dash", "ash", "zsh", "env", "ln", "rm", "cp", "mv", "ls", "cat", "echo", "test", "true", "false", "mkdir", "chmod", "chown", "mktemp", "readlink", "install", "tar", "gzip", "sha256sum", "curl", "wget",
	"apt", "apt-get", "dpkg", "npm", "node", "npx", "runuser", "su", "sudo", "ssh", "sshd", "systemctl", "ufw", "nft", "uname", "id", "cloud-init", "git", "tmux", "python", "python3", "perl",
}

// validateAgentBinary refuses a program name that is not plain, is one of Coral's nine programs or is a reserved name: ln -s into /usr/local/bin must never be able to replace a program.
func validateAgentBinary(b string) error {
	switch {
	case !agentBinaryRe.MatchString(b):
		return fmt.Errorf("the program name %q is not a plain name (a-z, 0-9, hyphen, underscore; starting with a letter; at most 32)", b)
	case slices.Contains(releasePrograms, b):
		return fmt.Errorf("the program name %q is one of Coral's own programs", b)
	case slices.Contains(reservedAgentNames, b):
		return fmt.Errorf("the program name %q is a program the machine uses", b)
	}
	return nil
}

func resolveAgents(entries []string) ([]agentInstall, error) {
	var out []agentInstall
	seen := map[string]bool{}
	for _, e := range entries {
		name, ver, ok := strings.Cut(e, "@")
		if !ok || ver == "" {
			return nil, fmt.Errorf("agent %q needs a pin: write %s@x.y.z (npm), or agy@sha256:<64 hex> (the installer's SHA-256)", e, name)
		}
		switch name {
		case at.Claude, at.Codex, at.Pi, at.Agy, at.Antigravity, at.Gemini:
		default:
			return nil, fmt.Errorf("agent %q is not one Coral installs on a machine (claude, codex, pi, agy)", name)
		}
		info := agent.GetCLIInfo(name)
		if info == nil {
			return nil, fmt.Errorf("agent %q has no install command", name)
		}
		if seen[info.Binary] {
			return nil, fmt.Errorf("agent %q is listed twice", info.Binary)
		}
		if err := validateAgentBinary(info.Binary); err != nil { // the name becomes a link in /usr/local/bin: it can only ever be added, never replace anything
			return nil, fmt.Errorf("agent %q: %w", name, err)
		}
		seen[info.Binary] = true
		inst := agentInstall{Name: name, Binary: info.Binary, Pinned: ver}
		if info.Binary == "agy" {
			m := sha256PinRe.FindStringSubmatch(ver)
			if m == nil {
				return nil, fmt.Errorf("agent agy has no version to pin: its installer is pinned by its SHA-256, agy@sha256:<64 hex> (an unpinned installer is not run)")
			}
			cmd := strings.TrimSpace(info.InstallCommand)
			const pre, post = "curl -fsSL ", " | bash"
			if !strings.HasPrefix(cmd, pre) || !strings.HasSuffix(cmd, post) {
				return nil, fmt.Errorf("agent agy: its install command is not a script this builder can fetch and check")
			}
			u := strings.TrimSuffix(strings.TrimPrefix(cmd, pre), post)
			if !installerRe.MatchString(u) {
				return nil, fmt.Errorf("agent agy: its installer URL is not one this builder can pin")
			}
			inst.AsCoral, inst.URL, inst.Hash = true, u, m[1]
			out = append(out, inst)
			continue
		}
		if !pinRe.MatchString(ver) {
			return nil, fmt.Errorf("agent %q: %q is not a version (x.y.z)", name, ver)
		}
		fields := strings.Fields(info.InstallCommand)
		if len(fields) < 4 || fields[0] != "npm" || fields[1] != "install" || fields[2] != "-g" {
			return nil, fmt.Errorf("agent %q: its install command is not an npm global install this builder can pin", name)
		}
		pkg := fields[len(fields)-1]
		if !npmPackageRe.MatchString(pkg) {
			return nil, fmt.Errorf("agent %q: its package name is not one this builder can pin", name)
		}
		fields[len(fields)-1] = pkg + "@" + ver
		inst.Command = strings.Join(fields, " ")
		inst.Package = pkg
		out = append(out, inst)
	}
	return out, nil
}

// BuildUserData returns the cloud-init user-data for spec, or the first thing wrong with it.
func BuildUserData(spec UserDataSpec) (string, error) {
	clientKey, err := canonicalClientKey(spec.ClientPublicKey)
	if err != nil {
		return "", err
	}
	mode := spec.MaxMode
	if mode == "" {
		mode = "view"
	}
	switch mode {
	case "view", "interact", "launch":
	default:
		return "", fmt.Errorf("max mode %q is not view, interact or launch", mode)
	}
	if !versionRe.MatchString(spec.CoralVersion) {
		return "", fmt.Errorf("the Coral version %q is not x.y.z", spec.CoralVersion)
	}
	if err := spec.CoralDigests.Valid(); err != nil {
		return "", err
	}
	hub := spec.HubURL
	if hub == "" {
		hub = DefaultHubURL
	}
	if !hubURLRe.MatchString(hub) {
		return "", fmt.Errorf("the Coral Hub URL is not an https origin")
	}
	hostPEM, hostPub, err := canonicalHostKey(spec.HostPrivateKey, spec.HostPublicKey)
	if err != nil {
		return "", err
	}
	sshFrom, err := canonicalSSHSource(spec.AllowSSHFrom)
	if err != nil {
		return "", err
	}
	agents, err := resolveAgents(spec.Agents)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	w("#cloud-config")
	w("# A Coral machine, made by `coral machine launch`. It holds NO secret of the person's and no Hub credential: that arrives over SSH, after the launcher has checked this machine's host key.")
	w("# The one inbound port is SSH, for the launch's own key only, until the launcher is done (or %s have passed).", bootstrapWindow)
	w("users:")
	w("  - name: coral")
	w("    gecos: Coral")
	w("    shell: /bin/bash")
	w("    lock_passwd: true # no password and no sudo")
	w("    ssh_authorized_keys: # the launch's own public key: the only way in, removed when the launcher is done")
	w("      - %s %s", clientKeyOptions, clientKey)
	w("ssh_deletekeys: true # the machine's own host keys are replaced by the one this launch pinned")
	w("ssh_genkeytypes: []")
	w("ssh_keys: # the single-use host key pair the launcher pinned: the one secret here, dead once setup finishes (coral-machine-finish)")
	w("  ed25519_private: |")
	for _, l := range strings.Split(strings.TrimRight(hostPEM, "\n"), "\n") {
		w("    %s", l)
	}
	w("  ed25519_public: %s", hostPub)
	w("package_update: true")
	w("packages:")
	for _, p := range []string{"ca-certificates", "curl", "git", "nftables", "tmux", "ufw"} { // node and npm are installed with the agent CLIs, after Coral has redeemed its credential
		w("  - %s", p)
	}
	w("write_files:")
	emitFile := func(path, perm, content string) {
		w("  - path: %s", path)
		w("    owner: root:root")
		w("    permissions: '%s'", perm)
		w("    content: |")
		for _, l := range strings.Split(strings.TrimRight(content, "\n"), "\n") {
			if l == "" {
				w("")
				continue
			}
			w("      %s", l)
		}
	}
	emitFile("/etc/systemd/system/coral.service", "0644", serviceUnit(hub, mode))
	emitFile("/etc/ssh/sshd_config.d/10-coral-bootstrap.conf", "0644", sshdConfig())
	emitFile("/etc/systemd/system/coral-bootstrap.path", "0644", bootstrapPathUnit())
	emitFile("/etc/systemd/system/coral-finish.path", "0644", finishPathUnit())
	emitFile("/etc/systemd/system/coral-finish.service", "0644", finishServiceUnit())
	emitFile("/etc/systemd/system/coral-finish.timer", "0644", finishTimerUnit())
	for _, f := range EgressFiles() { // #10918: every non-root user is off the metadata service and the private ranges (egress.go)
		emitFile(f.Path, f.Mode, f.Content)
	}
	emitFile("/usr/local/sbin/coral-machine-setup", "0700", setupScript(spec.CoralVersion, spec.CoralDigests))
	emitFile("/usr/local/sbin/coral-machine-finish", "0700", finishScript(len(agents) > 0))
	if len(agents) > 0 {
		emitFile("/usr/local/sbin/coral-machine-agents", "0700", agentsScript(agents))
	}
	w("runcmd:")
	w("  - [ systemctl, daemon-reload ]")
	w("  - [ systemctl, enable, --now, %s ] # the egress block, before anything else: coral.service Requires it, so Coral never starts without it", egressUnitName)
	w("  - [ systemctl, enable, --now, --no-block, %s ] # the resolver check, once the network is online: it only reports", egressResolvName)
	w("  - [ ufw, default, deny, incoming ]")
	w("  - [ ufw, default, allow, outgoing ]")
	w("  - [ ufw, allow, from, '%s', to, any, port, '22', proto, tcp ] # SSH, for the launcher's address only: closed again by coral-machine-finish", sshFrom)
	w("  - [ ufw, --force, enable ]")
	w("  - |")
	w("    (")
	w("      set -eu")
	w("      /usr/local/sbin/coral-machine-setup")
	w("      install -d -m 0755 -o root -g root /run/coral")
	w("      install -d -m 0700 -o coral -g coral /run/coral/bootstrap.d")
	w("      systemctl daemon-reload")
	w("      systemctl reload ssh || systemctl restart ssh || true")
	w("      systemctl enable --now coral-bootstrap.path coral-finish.path coral-finish.timer")
	w("    )")
	return b.String(), nil
}

// clientKeyOptions limits the launch key to a session: nothing forwarded, nothing tunnelled (Security's condition E on #10917).
const clientKeyOptions = "no-port-forwarding,no-agent-forwarding,no-X11-forwarding"

// canonicalHostKey checks the host key pair is one ed25519 OpenSSH private key with no passphrase and the public line of that same key, and returns the PEM and the canonical public line.
func canonicalHostKey(privPEM, pubLine string) (string, string, error) {
	if strings.TrimSpace(privPEM) == "" || strings.TrimSpace(pubLine) == "" {
		return "", "", fmt.Errorf("the launch's SSH host key pair is needed")
	}
	raw, err := ssh.ParseRawPrivateKey([]byte(privPEM))
	if err != nil {
		return "", "", fmt.Errorf("the launch's SSH host key is not a private key")
	}
	var priv ed25519.PrivateKey
	switch k := raw.(type) {
	case *ed25519.PrivateKey:
		priv = *k
	case ed25519.PrivateKey:
		priv = k
	default:
		return "", "", fmt.Errorf("the launch's SSH host key is not an ed25519 key")
	}
	signerPub, err := ssh.NewPublicKey(priv.Public())
	if err != nil {
		return "", "", err
	}
	given, _, opts, rest, err := ssh.ParseAuthorizedKey([]byte(pubLine))
	if err != nil || len(opts) != 0 || len(strings.TrimSpace(string(rest))) != 0 || !bytes.Equal(given.Marshal(), signerPub.Marshal()) {
		return "", "", fmt.Errorf("the launch's SSH host public key is not the public half of its private key")
	}
	return string(marshalHostKey(priv)), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signerPub))), nil
}

// canonicalClientKey checks the launch's SSH public key is one ed25519 key and nothing else (no options, no second line, no comment to carry anything) and returns it in its one canonical form.
func canonicalClientKey(line string) (string, error) {
	if strings.ContainsAny(line, "\r\n") && strings.TrimSpace(line) != strings.Trim(line, "\r\n ") {
		return "", fmt.Errorf("the launch key is not one public key")
	}
	pub, _, opts, rest, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil || len(opts) != 0 || len(strings.TrimSpace(string(rest))) != 0 {
		return "", fmt.Errorf("the launch key is not one ssh public key")
	}
	if pub.Type() != ssh.KeyAlgoED25519 {
		return "", fmt.Errorf("the launch key is not an ed25519 key")
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))), nil
}

// sshdConfig is the sshd drop-in for the bootstrap window: key only, coral only, nothing forwarded.
func sshdConfig() string {
	return `# Coral machine bootstrap: the launcher's one key, as coral, for the length of the launch.
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers coral
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
MaxAuthTries 2
LoginGraceTime 30
`
}

// bootstrapPathUnit starts Coral when the credential file appears: not before, so Coral never runs, or looks for a credential, until the launcher has delivered one.
func bootstrapPathUnit() string {
	return `[Unit]
Description=Start Coral when the launcher has delivered its one-time credential

[Path]
PathExists=/run/coral/bootstrap.d/credential
Unit=coral.service

[Install]
WantedBy=multi-user.target
`
}

// finishPathUnit runs the finish step when the launcher says it is done (the file "done" in the bootstrap folder).
func finishPathUnit() string {
	return `[Unit]
Description=Close the bootstrap SSH access when the launcher is done

[Path]
PathExists=/run/coral/bootstrap.d/done
Unit=coral-finish.service

[Install]
WantedBy=multi-user.target
`
}

func finishServiceUnit() string {
	return `[Unit]
Description=Close the bootstrap SSH access and finish setting up Coral

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/coral-machine-finish
`
}

// finishTimerUnit closes SSH on its own if the launcher never comes back.
func finishTimerUnit() string {
	return fmt.Sprintf(`[Unit]
Description=Close the bootstrap SSH access if the launcher never finishes

[Timer]
OnActiveSec=%s
Unit=coral-finish.service

[Install]
WantedBy=timers.target
`, bootstrapWindow)
}

// finishScript is the root step that ends the bootstrap window: sshd stopped and kept off, port 22 closed, the launch key and the host keys removed, Coral enabled for the next boot, and then the agent CLIs
// (when there are any and Coral is up). It can run twice (the timer after the launcher) and never fails the machine.
func finishScript(withAgents bool) string {
	var s strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	p("#!/bin/sh")
	p("# The end of the bootstrap window: no SSH any more, and nothing left that could open it again (a reboot, a cloud-init re-run, a snapshot restore). Safe to run twice.")
	p("# sshd is stopped AND masked, port 22 is closed, the host keys and the launch key are deleted, and so are cloud-init's own copies of the user-data (the provider keeps its copy: the key in it is dead).")
	p("# First of all the done file goes, so coral-finish.path (PathExists) cannot start this oneshot again when it exits: a long agent install would never trip the unit's start limit, and a failed agent must not re-trigger it.")
	p("rm -f /run/coral/bootstrap.d/done")
	p("systemctl disable --now ssh.socket ssh.service sshd.service 2>/dev/null || true")
	p("systemctl mask ssh.socket ssh.service sshd.service 2>/dev/null || true")
	p("ufw --force delete allow 22/tcp >/dev/null 2>&1 || true")
	p("rm -f /home/coral/.ssh/authorized_keys /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub")
	p("rm -f /etc/ssh/sshd_config.d/10-coral-bootstrap.conf")
	p("rm -rf /var/lib/cloud/instance/user-data.txt* /var/lib/cloud/instance/cloud-config.txt /var/lib/cloud/instance/scripts /var/lib/cloud/instance/vendor-data*")
	p("rm -rf /var/lib/cloud/instances/*/user-data.txt* /var/lib/cloud/instances/*/cloud-config.txt /var/lib/cloud/instances/*/scripts /var/lib/cloud/instances/*/vendor-data*")
	p("rm -f /var/lib/cloud/seed/nocloud*/user-data /var/lib/cloud/seed/nocloud*/meta-data")
	p("# cloud-init's pickled copy of the instance data, its instance-data JSON under /run, and the rotated logs hold the user-data too. Not a full cloud-init reset: a reboot would then run the user-data again and open SSH.")
	p("rm -f /var/lib/cloud/instance/obj.pkl /var/lib/cloud/instances/*/obj.pkl /var/lib/cloud/data/instance-data*.json /run/cloud-init/instance-data*.json /run/cloud-init/combined-cloud-config.json")
	p("rm -f /var/log/cloud-init.log.* /var/log/cloud-init-output.log.* /var/log/cloud-init*.log.*")
	p("for f in /var/log/cloud-init.log /var/log/cloud-init-output.log; do [ -f \"$f\" ] && : > \"$f\"; done")
	p("systemctl enable coral.service 2>/dev/null || true")
	if withAgents {
		p("# after Coral is up and has redeemed its credential: the agent CLIs (slow, and not needed to enroll)")
		p("rc=0")
		p("# The agents run ONCE, ever: the marker is on disk (/run is tmpfs and is gone after a reboot) and is written BEFORE they start, so a second start of this unit (the timer after a reboot, a retrigger) never installs")
		p("# them again, and a failed agent is not retried.")
		p("if [ ! -e /var/lib/coral-machine/agents-done ] && systemctl is-active --quiet coral.service; then")
		p("  install -d -m 0700 /var/lib/coral-machine")
		p("  touch /var/lib/coral-machine/agents-done")
		p("  /usr/local/sbin/coral-machine-agents || rc=1")
		p("fi")
	}
	p("# Nothing may start this unit again, with agents or without: the path and the timer are switched off for good (and stay off after a reboot).")
	p("systemctl disable --now coral-finish.timer coral-finish.path 2>/dev/null || true")
	if withAgents {
		p("exit $rc") // the machine is enrolled and SSH is closed by now: a failed agent makes this unit FAIL (named in the journal by coral-machine-agents), never a silent success
		return s.String()
	}
	p("exit 0")
	return s.String()
}

// serviceUnit is the systemd unit: Coral as coral, on loopback only (no --remote), connecting out to the Hub with the cap the launch chose.
func serviceUnit(hub, mode string) string {
	return fmt.Sprintf(`[Unit]
Description=Coral
After=network-online.target coral-egress.service
Wants=network-online.target
Requires=coral-egress.service

[Service]
User=coral
Group=coral
Environment=HOME=/home/coral
WorkingDirectory=/home/coral
ExecStart=/usr/local/bin/coral --cloud-url %s --cloud-max-mode %s --no-browser --host 127.0.0.1
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
`, hub, mode)
}

// releasePrograms are the members taken from the Coral release archive: the programs a Linux package ships (internal/updater/apply linuxPrograms, tests/release/commands.txt plus coral-update). Anything else in the archive is not
// extracted. An archive that lacks one of them fails the install (set -eu) rather than starting a machine without it.
var releasePrograms = []string{
	"coral", "launch-coral", "coral-board", "coral-agent",
	"coral-hook-agentic-state", "coral-hook-message-check", "coral-hook-session-start", "coral-hook-task-sync",
	"coral-update",
}

// setupScript installs the Coral release and stops at the first failure. The tarball is installed only after its SHA-256 matches the digest the launcher pinned for this release and architecture and passed in here: no
// checksum list is fetched on the machine, so there is nothing for a swapped download to agree with (#10919).
func setupScript(version string, digests ReleaseDigests) string {
	var s strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	p("#!/bin/sh")
	p("# Installs the Coral release, checked against the digest pinned in the launcher. Stops at the first failure: set -eu.")
	p("set -eu")
	p("")
	p("# The Coral release for this machine, verified before it is installed.")
	p("case \"$(uname -m)\" in")
	p("  x86_64) arch=amd64; want=%s ;;", digests.AMD64)
	p("  aarch64) arch=arm64; want=%s ;;", digests.ARM64)
	p("  *) echo \"coral-machine-setup: no Coral release for $(uname -m)\" >&2; exit 1 ;;")
	p("esac")
	p("version=%s", version)
	p("tarball=coral-linux-${arch}-${version}.tar.gz")
	p("base=https://github.com/%s/releases/download/v${version}", coralRepo)
	p("work=$(mktemp -d)")
	p("trap 'rm -rf \"$work\"' EXIT")
	p("cd \"$work\"")
	p("curl -fsSL --proto '=https' --tlsv1.2 -o \"$tarball\" \"$base/$tarball\"")
	p("echo \"${want}  ${tarball}\" | sha256sum -c -")
	p("# Only the named programs are taken from the archive (nothing else in it can land anywhere), and owned by root whatever the archive says.")
	p("tar -xzf \"$tarball\" -C /usr/local/bin/ --no-same-owner %s", strings.Join(releasePrograms, " "))
	p("test -x /usr/local/bin/coral")
	return s.String()
}

// npmAsCoral turns the table's "npm install -g PKG@VER" into one that installs under /opt/coral-agents with its cache there too (the coral user needs no home folder, and nothing is written outside it).
func npmAsCoral(cmd string) string {
	// --ignore-scripts is ALWAYS there (Security's ruling, #9934): an install-time script of a package never runs, as anyone. --registry names the official registry over HTTPS, and --userconfig and --globalconfig /dev/null keep any npm config file on the
	// machine (a scoped @scope:registry line included) from pointing the install elsewhere. This is the ONE place an agent's install command is built.
	return strings.Replace(cmd, "npm install -g", "npm install -g --ignore-scripts --userconfig /dev/null --globalconfig /dev/null --registry "+NPMRegistry+" --prefix /opt/coral-agents --cache /opt/coral-agents/.npm-cache", 1)
}

// NPMRegistry is the only registry the agents are installed from.
const NPMRegistry = "https://registry.npmjs.org/"

// agentsScript installs node and npm and the agent CLIs, from the one table of install commands, pinned where the installer takes a version. It runs after Coral has started, so a slow install
// never eats into the credential's short life.
func agentsScript(agents []agentInstall) string {
	var s strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	p("#!/bin/sh")
	p("# Installs the agent CLIs (after Coral is running). One agent's failure is said and does NOT stop the next one (each is its own && chain: set -e does not act inside a || list); a failed agent is REMOVED, and the")
	p("# script ends with a loud summary naming each failed agent and a NON-zero exit. A failed agent never turns scripts back on and is never retried with other flags.")
	p("set -u")
	p("failed=")
	needNode := false
	for _, a := range agents {
		if !a.AsCoral {
			needNode = true
		}
	}
	if needNode {
		p("DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs npm || exit 1")
	}
	for _, a := range agents {
		if a.AsCoral {
			p("# %s: the vendor's installer takes no version, so the script is fetched to a file, checked against the SHA-256 it was pinned to, and only then run, as the coral user.", a.Binary)
			p("( installer=$(mktemp) && { curl -fsSL --proto '=https' --tlsv1.2 -o \"$installer\" '%s' \\", a.URL)
			p("  && echo '%s  '\"$installer\" | sha256sum -c - \\", a.Hash)
			p("  && chmod 0644 \"$installer\" \\")
			p("  && runuser -u coral -- bash \"$installer\"; rc=$?; rm -f \"$installer\"; exit $rc; } ) || { echo \"coral-machine-agents: %s was not installed\" >&2; failed=\"$failed %s\"; }", a.Binary, a.Binary)
			continue
		}
		bin := "/opt/coral-agents/bin/" + a.Binary
		link := "/usr/local/bin/" + a.Binary
		p("# %s %s: installed by the coral user, never root, into a folder only it writes; scripts are not run, so the CLI is checked and a CLI that does not start fails LOUDLY and only that agent is lost. The link is made with ln -s -T and only if nothing is at that name: it can fail, never replace.", a.Binary, a.Pinned)
		p("# An agent that is already installed and runs (its link points at this install) is counted installed and left alone: a second run never cleans up what was good before it.")
		p("if runuser -u coral -- %s --version >/dev/null 2>&1 && [ \"$(readlink %s 2>/dev/null)\" = %s ]; then", bin, link, bin)
		p("  echo \"coral-machine-agents: %s is already installed\"", a.Binary)
		p("else")
		p("( install -d -m 0755 -o coral -g coral /opt/coral-agents \\")
		p("  && runuser -u coral -- %s \\", npmAsCoral(a.Command))
		p("  && test -x %s \\", bin)
		p("  && { runuser -u coral -- %s --version >/dev/null || { echo \"coral-machine-agents: %s did not start after an install with --ignore-scripts (its --version failed): it may need its install script, which is NOT run and is not to be enabled by hand: tell the person who runs Coral, so an exception goes through review\" >&2; false; }; } \\", bin, a.Binary)
		p("  && { test ! -e %s && test ! -L %s || { echo \"coral-machine-agents: %s already exists in /usr/local/bin and is left alone\" >&2; false; }; } \\", link, link, link)
		p("  && ln -s -T %s %s ) || {", bin, link)
		p("  echo \"coral-machine-agents: %s was not installed\" >&2; failed=\"$failed %s\"", a.Binary, a.Binary)
		p("  # remove what this agent left, but only a link that points at this install, never another file at that name")
		p("  if [ \"$(readlink %s 2>/dev/null)\" = %s ]; then rm -f %s; fi", link, bin, link)
		p("  rm -f %s; rm -rf /opt/coral-agents/lib/node_modules/%s", bin, a.Package)
		p("}")
		p("fi")
	}
	p("if [ -n \"$failed\" ]; then echo \"coral-machine-agents: FAILED agents:$failed (each was removed; the machine itself is enrolled)\" >&2; exit 1; fi")
	return s.String()
}
