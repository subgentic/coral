package sshprov

import (
	"archive/tar"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// farCfg makes a stand-in ssh the far computer: the closed commands in run.go are answered in Go, in a home folder in a temp dir, with no sh, tar, sha256sum or tmux (none of them is on Windows). It is
// told which command it was given by the text of the template (the last argument), as the sh -c on a real far computer would run it. It starts no process: a "coral" that "starts" is a record in a
// file, and its API key appears 0.3 s after, as the real one did.
type farCfg struct {
	Home     string // the far computer's $HOME
	TempRoot string // os.TempDir() of the test: Home must be inside it
	Log      string `json:",omitempty"` // the remote text of every command, one per line
	TmuxLog  string `json:",omitempty"` // what tmux would have been asked
	ArgsLog  string `json:",omitempty"` // the arguments coral "started" with (one line), plus .accept and .stdin for accept-terms
	Mode     string `json:",omitempty"` // "full": df says 100 KB free; "corrupt": the package is cut at 100 bytes on its way
	Key      string `json:",omitempty"` // the API key the started coral makes
	UnameOut string `json:",omitempty"`
}

// state is kept in the folder above Home, where a test flips it: session (a coral-server session exists), stuck (a kill does nothing), listening (a process of this user still runs Coral after the stop), noproc (the check cannot
// tell), portheld (another user holds 8420), started (when coral started, in unix nanoseconds).
func (f farCfg) flag(name string) bool {
	_, err := os.Stat(filepath.Join(filepath.Dir(f.Home), name))
	return err == nil
}

func (f farCfg) setFlag(name string, on bool) {
	p := filepath.Join(filepath.Dir(f.Home), name)
	if on {
		_ = os.WriteFile(p, nil, 0o600)
	} else {
		_ = os.Remove(p)
	}
}

// keepStdin reads all of stdin and, only when the test named a place for it (ArgsLog set, so the path is not just ".stdin" in the working directory), writes it there at 0600: a secret on stdin is never left in the
// source tree by a test that forgot to name one.
func keepStdin(path string) {
	b, _ := io.ReadAll(os.Stdin)
	if strings.HasPrefix(filepath.Base(path), ".") {
		return
	}
	_ = os.WriteFile(path, b, 0o600)
}

func appendLine(path, line string) {
	if path == "" || strings.HasPrefix(filepath.Base(path), ".") {
		return
	}
	if fh, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		fmt.Fprintln(fh, line)
		fh.Close()
	}
}

var (
	farVersionRe = regexp.MustCompile(`\.coral-server/([0-9][^/"']*)`)
	farShaArgRe  = regexp.MustCompile(`sha256sum -- '([^']*)'`)
)

// homeAllowed is (given the temp folder the test was started with, which the stand-in cannot ask for itself: its environment is minimal) whether the far computer's home may be written to: absolute, clean and inside the temp folder, so a wrong config can never make the emulator remove or write anywhere else (RemoveAll
// and the unpack run on it).
func homeAllowed(home, root string) bool {
	if root == "" || !filepath.IsAbs(root) || filepath.Dir(root) == root || home == "" || !filepath.IsAbs(home) || filepath.Clean(home) != home {
		return false
	}
	// Compared as files, not as spellings: Windows names one folder both C:\Users\RUNNER~1\... and C:\Users\runneradmin\..., and /var and /private/var are one folder on a Mac.
	rootSt, err := os.Stat(root)
	if err != nil {
		return false
	}
	// the deepest part of home that exists, with its links resolved: a home not made yet is judged by where it would be, and a link that leaves root is seen for where it leads
	e := home
	for {
		if _, err := os.Lstat(e); err == nil {
			break
		}
		parent := filepath.Dir(e)
		if parent == e {
			return false
		}
		e = parent
	}
	r, err := filepath.EvalSymlinks(e)
	if err != nil {
		return false
	}
	for p := r; ; p = filepath.Dir(p) {
		if st, err := os.Stat(p); err == nil && os.SameFile(st, rootSt) {
			return p != r || e != home // home itself being root is not inside it
		}
		if filepath.Dir(p) == p {
			return false
		}
	}
}

// runFar answers one command and returns its exit code.
func runFar(f farCfg, text string) int {
	if !homeAllowed(f.Home, f.TempRoot) {
		fmt.Fprintln(os.Stderr, "sshprov far side: its home is not inside the temp folder")
		return 2
	}
	appendLine(f.Log, text)
	install := filepath.Join(f.Home, InstallDir)
	vdir := ""
	if m := farVersionRe.FindStringSubmatch(text); m != nil && !strings.Contains(m[1], "..") {
		vdir = filepath.Join(install, m[1])
	}
	has := func(s string) bool { return strings.Contains(text, s) }
	cat := func(p string) int {
		b, err := os.ReadFile(p)
		if err != nil {
			return 1
		}
		os.Stdout.Write(b)
		return 0
	}
	switch {
	case has("uname -sm"):
		out := f.UnameOut
		if out == "" {
			out = "Linux x86_64"
		}
		fmt.Println(out)
		return 0
	case has("command -v tmux"), has("systemctl --user"):
		return 0
	case has(`ps -u "$(id -u)"`): // the check after a stop: the session, then THIS user's own Coral process (the flag listening), never the port
		switch {
		case f.flag("session"):
			return 1
		case f.flag("noproc"):
			return 3
		case f.flag("listening"):
			return 2
		}
		return 0
	case has("[ -r /proc/net/tcp ]"): // the check before a start: this user's session means nothing to check; otherwise 8420 held by another (the flag portheld)
		if f.flag("session") {
			return 0
		}
		if f.flag("portheld") {
			return 2
		}
		return 0
	case has("df -Pk"):
		if f.Mode == "full" {
			fmt.Println(100)
		} else {
			fmt.Println(99999999)
		}
		return 0
	case has("tmux new-session -d -s coral-server"):
		_ = os.MkdirAll(filepath.Join(install, "data"), 0o700)
		appendLine(f.TmuxLog, "has-session -t =coral-server")
		if f.flag("session") {
			return 0
		}
		appendLine(f.TmuxLog, "new-session -d -s coral-server")
		f.setFlag("session", true)
		if i := strings.Index(text, `root/coral\"`); i >= 0 {
			rest := text[i+len(`root/coral\"`):]
			if j := strings.LastIndex(rest, `"; }`); j >= 0 {
				rest = rest[:j]
			}
			rest = filepath.FromSlash(strings.ReplaceAll(strings.ReplaceAll(rest, `\"`, ""), "$HOME", f.Home)) // the path as this system writes it
			appendLine(f.ArgsLog, strings.TrimSpace(rest))
		}
		_ = os.WriteFile(filepath.Join(filepath.Dir(f.Home), "started"), []byte(fmt.Sprint(time.Now().UnixNano())), 0o600)
		return 0
	case has("instance-id\" && { [ -s"):
		if err := os.MkdirAll(install, 0o700); err != nil {
			return 1
		}
		p := filepath.Join(install, "instance-id")
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			b := make([]byte, 16)
			_, _ = rand.Read(b)
			if err := os.WriteFile(p, []byte(hex.EncodeToString(b)), 0o600); err != nil {
				return 1
			}
		}
		return cat(p)
	case has(`/instance-id" 2>/dev/null`):
		return cat(filepath.Join(install, "instance-id"))
	case has("api-key --home"):
		p := filepath.Join(install, "data", "api_key")
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			b, err := os.ReadFile(filepath.Join(filepath.Dir(f.Home), "started"))
			var at int64
			fmt.Sscan(string(b), &at)
			if err != nil || time.Since(time.Unix(0, at)) < 300*time.Millisecond || f.Key == "" {
				return 1
			}
			_ = os.MkdirAll(filepath.Dir(p), 0o700)
			_ = os.WriteFile(p, []byte(f.Key+"\n"), 0o600)
		}
		return cat(p)
	case has(`root/coral" accept-terms`):
		appendLine(f.ArgsLog+".accept", "accept-terms")
		keepStdin(f.ArgsLog + ".stdin")
		return 0
	case has(`root/coral" hub-owner-secret`): // the owner stamp's secret on stdin, never in argv (#11378): what was asked and what came in are kept for the test
		appendLine(f.ArgsLog+".owner", "hub-owner-secret --home "+filepath.Join(install, "data"))
		keepStdin(f.ArgsLog + ".owner.stdin")
		return 0
	case has("tmux kill-session"):
		appendLine(f.TmuxLog, "kill-session -t =coral-server")
		if !f.flag("stuck") {
			f.setFlag("session", false)
		}
		return 0
	case has("for d in [0-9]*"):
		ents, _ := os.ReadDir(install)
		for _, e := range ents {
			if e.IsDir() && e.Name()[0] >= '0' && e.Name()[0] <= '9' {
				_ = os.RemoveAll(filepath.Join(install, e.Name()))
			}
		}
		return 0
	case has(`rm -rf "$HOME/` + InstallDir + `"`):
		_ = os.RemoveAll(install)
		return 0
	case has("package.tar.gz\"") && has("cat >"):
		if vdir == "" {
			return 1
		}
		var r io.Reader = os.Stdin
		if f.Mode == "corrupt" {
			r = io.LimitReader(os.Stdin, 100)
		}
		fh, err := os.OpenFile(filepath.Join(vdir, "package.tar.gz"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot create package.tar.gz")
			return 1
		}
		_, err = io.Copy(fh, r)
		if cerr := fh.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return 1
		}
		return 0
	case has("tar -tzf package.tar.gz"):
		return farTarList(filepath.Join(vdir, "package.tar.gz"))
	case has("tar -xzf package.tar.gz"):
		return farUnpack(vdir)
	case has("package.sha256\" 2>/dev/null"):
		return cat(filepath.Join(vdir, "package.sha256"))
	case has("sha256sum -- '"):
		m := farShaArgRe.FindStringSubmatch(text)
		if m == nil || strings.Contains(m[1], "..") || filepath.IsAbs(m[1]) {
			return 1
		}
		b, err := os.ReadFile(filepath.Join(install, filepath.FromSlash(m[1])))
		if err != nil {
			return 1
		}
		sum := sha256.Sum256(b)
		fmt.Printf("%s  %s\n", hex.EncodeToString(sum[:]), m[1])
		return 0
	case has("mkdir -p \"$HOME/" + InstallDir + "/"):
		if vdir == "" {
			return 1
		}
		if os.MkdirAll(vdir, 0o700) != nil {
			return 1
		}
		_ = os.Chmod(install, 0o700)
		_ = os.Chmod(vdir, 0o700)
		return 0
	}
	fmt.Fprintln(os.Stderr, "sshprov far side: a command the tests do not know:", text)
	return 127
}

func farTarList(pkg string) int {
	fh, err := os.Open(pkg)
	if err != nil {
		return 2
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gzip: not in gzip format")
		return 2
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return 0
		}
		if err != nil {
			return 2
		}
		fmt.Println(h.Name)
	}
}

// farUnpack is the unpack command: the recorded sum first removed, the root made again, the members extracted under it (a name that leaves it is refused, as a good tar would), the sum written last.
func farUnpack(vdir string) int {
	pkg := filepath.Join(vdir, "package.tar.gz")
	_ = os.Remove(filepath.Join(vdir, "package.sha256"))
	root := filepath.Join(vdir, "root")
	_ = os.RemoveAll(root)
	if os.Mkdir(root, 0o700) != nil {
		return 1
	}
	fh, err := os.Open(pkg)
	if err != nil {
		return 2
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		return 2
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 2
		}
		rel := filepath.Clean(filepath.FromSlash(h.Name))
		if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return 2
		}
		dst := filepath.Join(root, rel)
		switch h.Typeflag {
		case tar.TypeDir:
			_ = os.MkdirAll(dst, 0o700)
		case tar.TypeSymlink:
			_ = os.Symlink(h.Linkname, dst) // best effort: making a link needs a privilege on Windows
		case tar.TypeReg:
			_ = os.MkdirAll(filepath.Dir(dst), 0o700)
			out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o700)
			if err != nil {
				return 2
			}
			_, err = io.Copy(out, tr)
			out.Close()
			if err != nil {
				return 2
			}
		}
	}
	b, err := os.ReadFile(pkg)
	if err != nil {
		return 1
	}
	sum := sha256.Sum256(b)
	if os.WriteFile(filepath.Join(vdir, "package.sha256"), []byte(hex.EncodeToString(sum[:])+"\n"), 0o600) != nil {
		return 1
	}
	return 0
}
