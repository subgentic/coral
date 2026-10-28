package machinelaunch

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// The instance's cloud-init user-data (#9973, design note #9934 section 3): a stock Ubuntu LTS image, no image of ours. In order: a user `coral` with no password and no sudo; the few packages Coral
// needs; the firewall (deny incoming: the machine connects OUT to Coral Hub, so no port is open); the Coral release for the pinned version with its SHA-256 checked against the release's
// SHA256SUMS.txt before anything is installed; the Hub's one-time credential written to tmpfs (0600, owned by coral, in a folder only coral reads); and the Coral service as coral, on loopback only.
// That is ONE shell step that stops at the first failure, so Coral never starts, and the credential is never written, if a download or a checksum fails. The credential's TTL is short (minutes, from
// the mint), so everything slow comes AFTER Coral has started and redeemed it: the agent CLIs (node, npm and the pinned installs) are a second step that runs only once the service is active.
//
// The credential is the only secret in it, it appears once, and it is short-lived and single-use (the Hub's half). Every value that goes into a command is checked against a pattern first: nothing a
// caller passes is ever quoted into the shell, it is refused unless it is already safe.

// UserDataSpec is what BuildUserData needs.
type UserDataSpec struct {
	// Credential is the Hub's one-time bootstrap credential (chb_...). Never logged.
	Credential string
	// MaxMode is the most Coral Hub may do on the machine: view, interact or launch. Empty is view.
	MaxMode string
	// CoralVersion is the release to install, x.y.z (no "v"). Required.
	CoralVersion string
	// Agents are the agent CLIs to install: "name@version" for the npm-installed ones (claude, codex, pi), which must be pinned; "agy@sha256:<64 hex>" for Antigravity's installer, which takes no
	// version: the installer script is fetched to a file, checked against that SHA-256 and only then run, and it runs only when this says so. Every installer fetched on the machine is pinned this
	// way, none is piped into a shell. The names come from the one table of CLIs (internal/agent).
	Agents []string
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

var (
	credentialRe = regexp.MustCompile(`^chb_[A-Za-z0-9_-]{16,256}$`)
	versionRe    = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`)
	pinRe        = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z.]{1,40})?$`)
	hubURLRe     = regexp.MustCompile(`^https://[a-z0-9]([a-z0-9.-]{0,80}[a-z0-9])?(:[0-9]{1,5})?$`)
	npmPackageRe = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
)

// agentInstallCommand is the install command of an agent type's CLI, from the one table (agent.GetCLIInfo): the npm ones are rebuilt with the pinned version, never copied.
type agentInstall struct {
	Name    string
	Binary  string
	Command string // the npm command to run as root (empty for agy)
	AsCoral bool   // agy: its installer script, checked against Hash, run as coral
	Pinned  string // the version, or sha256:<hex> for agy
	URL     string // agy: the installer's URL, from the table
	Hash    string // agy: the installer's SHA-256 (64 hex)
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
		out = append(out, inst)
	}
	return out, nil
}

// BuildUserData returns the cloud-init user-data for spec, or the first thing wrong with it.
func BuildUserData(spec UserDataSpec) (string, error) {
	if !credentialRe.MatchString(spec.Credential) {
		return "", fmt.Errorf("the credential is not a Coral Hub bootstrap credential (chb_...)")
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
	hub := spec.HubURL
	if hub == "" {
		hub = DefaultHubURL
	}
	if !hubURLRe.MatchString(hub) {
		return "", fmt.Errorf("the Coral Hub URL is not an https origin")
	}
	agents, err := resolveAgents(spec.Agents)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	w("#cloud-config")
	w("# A Coral machine, made by `coral machine launch`. It holds one secret: the Coral Hub one-time credential in the last step, single use and short-lived.")
	w("# Nothing here opens an inbound port: the machine connects out to Coral Hub.")
	w("users:")
	w("  - name: coral")
	w("    gecos: Coral")
	w("    shell: /bin/bash")
	w("    lock_passwd: true # no password and no sudo, and no ssh key is added")
	w("package_update: true")
	w("packages:")
	for _, p := range []string{"ca-certificates", "curl", "git", "tmux", "ufw"} { // node and npm are installed with the agent CLIs, after Coral has redeemed its credential
		w("  - %s", p)
	}
	w("write_files:")
	w("  - path: /etc/systemd/system/coral.service")
	w("    owner: root:root")
	w("    permissions: '0644'")
	w("    content: |")
	for _, l := range strings.Split(strings.TrimRight(serviceUnit(hub, mode), "\n"), "\n") {
		if l == "" {
			w("")
			continue
		}
		w("      %s", l)
	}
	emitScript := func(path, content string) {
		w("  - path: %s", path)
		w("    owner: root:root")
		w("    permissions: '0700'")
		w("    content: |")
		for _, l := range strings.Split(strings.TrimRight(content, "\n"), "\n") {
			if l == "" {
				w("")
				continue
			}
			w("      %s", l)
		}
	}
	emitScript("/usr/local/sbin/coral-machine-setup", setupScript(spec.CoralVersion))
	if len(agents) > 0 {
		emitScript("/usr/local/sbin/coral-machine-agents", agentsScript(agents))
	}
	w("runcmd:")
	w("  - [ ufw, default, deny, incoming ]")
	w("  - [ ufw, default, allow, outgoing ]")
	w("  - [ ufw, --force, enable ]")
	w("  - |")
	w("    (")
	w("      set -eu")
	w("      /usr/local/sbin/coral-machine-setup")
	w("      install -d -m 0755 -o root -g root /run/coral")
	w("      install -d -m 0700 -o coral -g coral /run/coral/bootstrap.d")
	w("      (umask 077; printf '%%s' '%s' > /run/coral/bootstrap.d/credential)", spec.Credential)
	w("      chown coral:coral /run/coral/bootstrap.d/credential")
	w("      chmod 0600 /run/coral/bootstrap.d/credential")
	w("      systemctl daemon-reload")
	w("      systemctl enable --now coral.service")
	w("    )")
	if len(agents) > 0 {
		w("  - |")
		w("    # after Coral is up and has redeemed its credential: the agent CLIs (slow, and not needed to enroll)")
		w("    if systemctl is-active --quiet coral.service; then /usr/local/sbin/coral-machine-agents; fi")
	}
	return b.String(), nil
}

// serviceUnit is the systemd unit: Coral as coral, on loopback only (no --remote), connecting out to the Hub with the cap the launch chose.
func serviceUnit(hub, mode string) string {
	return fmt.Sprintf(`[Unit]
Description=Coral
After=network-online.target
Wants=network-online.target

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

// setupScript installs the Coral release and stops at the first failure. The tarball is installed only after its SHA-256 matches the one line of the release's SHA256SUMS.txt that names it.
func setupScript(version string) string {
	var s strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	p("#!/bin/sh")
	p("# Installs the Coral release, checked against its SHA256SUMS.txt. Stops at the first failure: set -eu.")
	p("set -eu")
	p("")
	p("# The Coral release for this machine, verified before it is installed.")
	p("case \"$(uname -m)\" in")
	p("  x86_64) arch=amd64 ;;")
	p("  aarch64) arch=arm64 ;;")
	p("  *) echo \"coral-machine-setup: no Coral release for $(uname -m)\" >&2; exit 1 ;;")
	p("esac")
	p("version=%s", version)
	p("tarball=coral-linux-${arch}-${version}.tar.gz")
	p("base=https://github.com/%s/releases/download/v${version}", coralRepo)
	p("work=$(mktemp -d)")
	p("trap 'rm -rf \"$work\"' EXIT")
	p("cd \"$work\"")
	p("curl -fsSL --proto '=https' --tlsv1.2 -o \"$tarball\" \"$base/$tarball\"")
	p("curl -fsSL --proto '=https' --tlsv1.2 -o SHA256SUMS.txt \"$base/SHA256SUMS.txt\"")
	p("grep -E \"^[0-9a-f]{64} [ *]${tarball}\\$\" SHA256SUMS.txt > expected.sum")
	p("[ \"$(wc -l < expected.sum)\" -eq 1 ] || { echo \"coral-machine-setup: SHA256SUMS.txt does not list $tarball exactly once\" >&2; exit 1; }")
	p("sha256sum -c expected.sum")
	p("tar -xzf \"$tarball\" -C /usr/local/bin/")
	p("test -x /usr/local/bin/coral")
	return s.String()
}

// agentsScript installs node and npm and the agent CLIs, from the one table of install commands, pinned where the installer takes a version. It runs after Coral has started, so a slow install
// never eats into the credential's short life.
func agentsScript(agents []agentInstall) string {
	var s strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	p("#!/bin/sh")
	p("# Installs the agent CLIs (after Coral is running). Stops at the first failure: set -eu.")
	p("set -eu")
	needNode := false
	for _, a := range agents {
		if !a.AsCoral {
			needNode = true
		}
	}
	if needNode {
		p("DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs npm")
	}
	for _, a := range agents {
		if a.AsCoral {
			p("# %s: the vendor's installer takes no version, so the script is fetched to a file, checked against the SHA-256 it was pinned to, and only then run, as the coral user.", a.Binary)
			p("installer=$(mktemp)")
			p("curl -fsSL --proto '=https' --tlsv1.2 -o \"$installer\" '%s'", a.URL)
			p("echo '%s  '\"$installer\" | sha256sum -c -", a.Hash)
			p("chmod 0644 \"$installer\"")
			p("runuser -u coral -- bash \"$installer\"")
			p("rm -f \"$installer\"")
			continue
		}
		p("# %s %s", a.Binary, a.Pinned)
		p("%s", a.Command)
	}
	return s.String()
}
