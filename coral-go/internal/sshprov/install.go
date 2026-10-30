package sshprov

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// Installing a Coral release on the far computer (#11370). Nothing here is built from request data: the version is the hub's own running version (a hub puts only ITS release on another computer),
// the asset is a fixed per-architecture name, the download folder is a fresh 0700 temp, and every command on the far side is one of the closed list in run.go.
//
// The order is the safety: download and verify on the hub (SHA256SUMS against its Sigstore bundle for exactly this tag, then the package hash), refuse any package whose member names are not plain
// relative paths, copy it, hash it again WITH sha256sum ON THE FAR SIDE and compare, list it there and check the names again, then unpack under the install folder with a 0077 umask and no owner.

// Arch is a far computer's architecture as the release names its package.
type Arch string

const (
	ArchAMD64 Arch = "amd64"
	ArchARM64 Arch = "arm64"
)

// ArchOf maps `uname -sm` to the release's architecture; ok is false for anything but Linux x86_64 and aarch64.
func ArchOf(uname string) (Arch, bool) {
	switch strings.TrimSpace(uname) {
	case "Linux x86_64":
		return ArchAMD64, true
	case "Linux aarch64":
		return ArchARM64, true
	}
	return "", false
}

// The release files, from the repository the updater pins.
const (
	releaseBase    = "https://github.com/subgentic/coral/releases/download/"
	sumsName       = "SHA256SUMS.txt"
	sumsBundleName = "SHA256SUMS.txt.sigstore.json"
	maxSums        = 64 << 10
	maxBundle      = 256 << 10
	maxPackage     = 300 << 20
	maxMembers     = 20000
	maxUnpacked    = 2 << 30
)

// AllowedHosts are the hosts a release download may be served from, as the updater allows (a redirect to anything else is refused).
var AllowedHosts = []string{"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}

// Installer puts the hub's release on a far computer. Download, RunHelper and the Runner are replaced in tests; Progress hears each step in a fixed sentence.
type Installer struct {
	Runner Runner
	// Version is the hub's own running version, and the only one installed (SemVer, no "v").
	Version string
	// Helper is the ABSOLUTE path of coral-update (verify-package), the only program that links the Sigstore verifier. Empty or missing refuses the install.
	Helper string
	// Download fetches url into the file at dst (created new, 0600), at most max bytes. Nil uses the hardened downloader.
	Download func(ctx context.Context, url, dst string, max int64) error
	// RunHelper runs the verifier. Nil runs Helper with a minimal environment and a timeout.
	RunHelper func(ctx context.Context, tag, asset, dir string) (sha string, err error)
	// Progress is told the state of a step ("running", "ok", "failed", "skipped") with one fixed sentence.
	Progress func(step, state, detail string)
	// TempDir is where the 0700 download folder is made; empty is the system's.
	TempDir string
}

// ErrInstall is every refusal of the install: the sentence is for the owner, fixed, with no text from the far computer or the network in it.
type ErrInstall struct{ Step, Msg string }

func (e *ErrInstall) Error() string { return e.Step + ": " + e.Msg }

func (in Installer) say(step, state, detail string) {
	if in.Progress != nil {
		in.Progress(step, state, detail)
	}
}

func fail(step, msg string) error { return &ErrInstall{Step: step, Msg: msg} }

var hexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Install installs the hub's release for arch on t and returns the package's SHA-256. A re-run finds the release already installed (the far side's recorded SHA-256 equals the verified one) and
// does not copy or unpack again.
func (in Installer) Install(ctx context.Context, t Target, arch Arch) (string, error) {
	if !versionRe.MatchString(in.Version) {
		return "", fail("install", "This hub is a development build, so there is no release to install.")
	}
	if arch != ArchAMD64 && arch != ArchARM64 {
		return "", fail("install", "This computer's architecture is not supported yet.")
	}
	tag := "v" + in.Version
	asset := "coral-linux-" + string(arch) + "-" + in.Version + ".tar.gz"
	in.say("install", "running", "Installing the release this hub runs ("+tag+"), not another version.")

	dir, err := os.MkdirTemp(in.TempDir, "coral-install-")
	if err != nil {
		return "", fail("install", "Could not make a download folder.")
	}
	defer os.RemoveAll(dir)
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fail("install", "Could not make a download folder.")
	}
	dl := in.Download
	if dl == nil {
		dl = downloadRelease
	}
	for _, f := range []struct {
		name string
		max  int64
	}{{sumsName, maxSums}, {sumsBundleName, maxBundle}, {asset, maxPackage}} {
		in.say("install", "running", "Downloading "+f.name+".")
		if err := dl(ctx, releaseBase+tag+"/"+f.name, filepath.Join(dir, f.name), f.max); err != nil {
			return "", fail("install", "Could not download "+f.name+" from GitHub.")
		}
	}

	in.say("install", "running", "Checking the release signature and the package hash on this computer.")
	run := in.RunHelper
	if run == nil {
		run = in.runHelper
	}
	sum, err := run(ctx, tag, asset, dir)
	if err != nil || !hexRe.MatchString(sum) {
		return "", fail("install", "The release could not be verified, so nothing was installed.")
	}
	unpacked, err := checkLocalPackage(filepath.Join(dir, asset))
	if err != nil {
		return "", fail("install", "The package holds paths that are not allowed, so nothing was installed.")
	}
	pkgSize := int64(0)
	if st, err := os.Stat(filepath.Join(dir, asset)); err == nil {
		pkgSize = st.Size()
	}

	// Already installed? (a re-run)
	if r, err := in.Runner.Run(ctx, t, CmdReadInstalledSum, in.Version); err == nil && strings.TrimSpace(r.Stdout) == sum {
		in.say("install", "ok", "Already installed, and the package matches.")
		return sum, nil
	} else if err != nil {
		return "", connectErr(err)
	}

	// Room for the package and what it unpacks to, and a margin, before anything is copied.
	need := (pkgSize+unpacked)/1024 + diskMarginKB
	fr, err := in.Runner.Run(ctx, t, CmdFreeKB)
	if err != nil {
		return "", connectErr(err)
	}
	if free, ok := parseKB(fr.Stdout); !ok || free < need {
		return "", fail("install", "There is not enough free disk space on the other computer.")
	}
	in.say("install", "running", "Copying the package to the other computer.")
	if _, err := in.Runner.Run(ctx, t, CmdMkVersionDir, in.Version); err != nil {
		return "", connectErr(err)
	}
	f, err := os.Open(filepath.Join(dir, asset))
	if err != nil {
		return "", fail("install", "Could not read the package.")
	}
	defer f.Close()
	if r, err := in.Runner.RunInput(ctx, t, f, CmdReceive, in.Version); err != nil || r.ExitCode != 0 {
		return "", connectErr(err)
	}

	// (d) the far side hashes what it received with sha256sum, and the hub compares.
	in.say("install", "running", "Checking the package on the other computer.")
	r, err := in.Runner.Run(ctx, t, CmdSha256, in.Version+"/package.tar.gz")
	if err != nil {
		return "", connectErr(err)
	}
	if fields := strings.Fields(r.Stdout); len(fields) == 0 || fields[0] != sum {
		return "", fail("install", "The package that arrived is not the one that was verified, so nothing was unpacked.")
	}
	lr, err := in.Runner.Run(ctx, t, CmdTarList, in.Version)
	if err != nil {
		return "", connectErr(err)
	}
	if err := checkMemberNames(strings.Split(strings.TrimRight(lr.Stdout, "\n"), "\n")); err != nil || lr.ExitCode != 0 {
		return "", fail("install", "The package holds paths that are not allowed, so nothing was unpacked.")
	}
	in.say("install", "running", "Unpacking.")
	if ur, err := in.Runner.Run(ctx, t, CmdUnpack, in.Version); err != nil || ur.ExitCode != 0 {
		if err != nil {
			return "", connectErr(err)
		}
		return "", fail("install", "Could not unpack the package on the other computer.")
	}
	in.say("install", "ok", "Installed "+tag+" under ~/"+InstallDir+".")
	return sum, nil
}

// diskMarginKB is the free space kept beyond the package and its unpacked size (100 MiB).
const diskMarginKB = 100 << 10

// parseKB reads the one number df printed: digits only, at most 15.
func parseKB(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 15 {
		return 0, false
	}
	var n int64
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int64(r-'0')
	}
	return n, true
}

func connectErr(err error) error {
	if errors.Is(err, ErrHostKey) || errors.Is(err, ErrHostKeyChanged) {
		return fail("install", "The host key no longer matches.")
	}
	return fail("install", "Could not connect, or a command on the other computer failed.")
}

// checkMemberNames refuses a member name that is absolute, has a ".." element, a backslash or a control character, is empty, or is far too long; and a list that is empty or too long.
func checkMemberNames(names []string) error {
	if len(names) == 0 || len(names) > maxMembers || (len(names) == 1 && names[0] == "") {
		return errors.New("no members, or too many")
	}
	for _, n := range names {
		if err := checkMemberName(n); err != nil {
			return err
		}
	}
	return nil
}

func checkMemberName(n string) error {
	if n == "" || len(n) > 512 || strings.HasPrefix(n, "/") || strings.ContainsAny(n, "\\\x00") {
		return fmt.Errorf("member name %q", n)
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("member name has a control character")
		}
	}
	for _, el := range strings.Split(strings.TrimSuffix(n, "/"), "/") {
		if el == ".." {
			return fmt.Errorf("member name %q has ..", n)
		}
	}
	return nil
}

// checkLocalPackage reads the verified package's members on the hub: names as above, only files, folders and symlinks (no hard link, device or FIFO), a bounded count and size. A symlink's target must be
// relative with no ".." element, and no member's path may pass through an EARLIER symlink member: with those two rules a chain such as sub/y -> .. and then x -> sub/y/.. cannot be built, whatever tar
// does on the far side. It returns the unpacked size.
func checkLocalPackage(file string) (int64, error) {
	f, err := os.Open(file)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, err
	}
	tr := tar.NewReader(gz)
	var count int
	var total int64
	links := map[string]bool{} // clean paths of the symlink members seen so far
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		count++
		if count > maxMembers {
			return 0, errors.New("too many members")
		}
		if err := checkMemberName(h.Name); err != nil {
			return 0, err
		}
		clean := path.Clean(h.Name)
		for p := path.Dir(clean); p != "." && p != "/"; p = path.Dir(p) {
			if links[p] {
				return 0, fmt.Errorf("member %q passes through a link", h.Name)
			}
		}
		switch h.Typeflag {
		case tar.TypeReg, tar.TypeDir:
			total += h.Size
		case tar.TypeSymlink:
			if h.Linkname == "" || strings.HasPrefix(h.Linkname, "/") || strings.ContainsAny(h.Linkname, "\\\x00") {
				return 0, fmt.Errorf("link target of %q", h.Name)
			}
			for _, el := range strings.Split(h.Linkname, "/") {
				if el == ".." {
					return 0, fmt.Errorf("link %q has .. in its target", h.Name)
				}
			}
			links[clean] = true
		default:
			return 0, fmt.Errorf("member %q has a type that is not allowed", h.Name)
		}
		if total > maxUnpacked {
			return 0, errors.New("too large when unpacked")
		}
	}
	if count == 0 {
		return 0, errors.New("empty package")
	}
	return total, nil
}

// runHelper runs `coral-update verify-package` by its absolute path with a minimal environment and a timeout, and reads its JSON answer. Anything but "verified" with a SHA-256 is a refusal.
func (in Installer) runHelper(ctx context.Context, tag, asset, dir string) (string, error) {
	if in.Helper == "" || !filepath.IsAbs(in.Helper) {
		return "", errors.New("no verifier")
	}
	if st, err := os.Stat(in.Helper); err != nil || !st.Mode().IsRegular() {
		return "", errors.New("no verifier")
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()
	cmd := executil.Command(ctx, in.Helper, "verify-package", "--tag", tag, "--asset", asset, "--dir", dir)
	cmd.Env = helperEnv()
	var out capped
	cmd.Stdout, cmd.Stdin = &out, nil
	if err := cmd.Run(); err != nil {
		return "", errors.New("not verified")
	}
	var o struct {
		Result string `json:"result"`
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(out.b.Bytes(), &o); err != nil || o.Result != "verified" {
		return "", errors.New("not verified")
	}
	return o.SHA256, nil
}

// helperEnv is what the verifier is given: where the hub's data is (its Sigstore trust cache lives there), a home, and the path. Nothing else of the hub's environment.
func helperEnv() []string {
	env := []string{"LC_ALL=C"}
	for _, k := range []string{"HOME", "USERPROFILE", "PATH", "CORAL_DATA_DIR", "TMPDIR", "SystemRoot"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// releaseTransport is the download's transport; nil is the default. A test supplies one that trusts its own server.
var releaseTransport http.RoundTripper

// downloadRelease fetches rawURL (https, an allowed host, at most three redirects each to an allowed host) into dst, at most max bytes, and fails on a longer body.
func downloadRelease(ctx context.Context, rawURL, dst string, max int64) error {
	check := func(u *url.URL) error {
		if u.Scheme != "https" || u.User != nil {
			return errors.New("not https, or has credentials")
		}
		h := strings.ToLower(u.Hostname())
		for _, a := range AllowedHosts {
			if h == a {
				return nil
			}
		}
		return errors.New("host not allowed")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if err := check(u); err != nil {
		return err
	}
	client := &http.Client{Timeout: 15 * time.Minute, Transport: releaseTransport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 3 {
			return errors.New("too many redirects")
		}
		return check(req.URL)
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, max+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > max {
		err = errors.New("the body is larger than the limit")
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}

// HelperPath is coral-update beside the running executable, absolute (the symlink of the executable resolved, as the updater does); empty when there is none, and the install then refuses.
func HelperPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	name := "coral-update"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(filepath.Dir(exe), name)
}
