package heavy

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// ClientLimits are what the sending side refuses to send: a refusal with the size is better than a silent copy of 2 GB. They sit under the wrapper's own caps.
type ClientLimits struct {
	Files int
	Bytes int64
}

// DefaultClientLimits are the caps of a send.
var DefaultClientLimits = ClientLimits{Files: 20000, Bytes: 256 << 20}

// FileEntry is one thing to send.
type FileEntry struct {
	Name   string // slash path from the worktree root
	Size   int64
	Exec   bool
	Link   string // for a symlink: its target, as it is in the worktree
	IsLink bool
}

// Skip is one thing left out, and why (said in the output).
type Skip struct{ Name, Why string }

// FileSet is what FileList decided.
type FileSet struct {
	Send    []FileEntry
	Skipped []Skip
	Bytes   int64
}

// codeExt are the extensions of source and text whose names may say "token" or "credentials" without being secrets (internal/background/token_poller.go builds the product).
var codeExt = map[string]bool{".go": true, ".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true, ".jsx": true, ".css": true, ".html": true, ".md": true, ".sh": true, ".py": true, ".rs": true, ".c": true, ".h": true, ".sql": true}

// looksSecret is the belt and braces beyond git's own ignore: a name that looks like a key or a credential is not sent even when git does not ignore it. .env*, *.pem, *.key and id_* never; credentials* and *token* unless the
// file is source or text by its extension.
func looksSecret(base string) bool {
	l := strings.ToLower(base)
	switch {
	case strings.HasPrefix(l, ".env"), strings.HasSuffix(l, ".pem"), strings.HasSuffix(l, ".key"), strings.HasPrefix(l, "id_"):
		return true
	case strings.Contains(l, "credentials"), strings.Contains(l, "token"):
		return !codeExt[strings.ToLower(filepath.Ext(l))]
	}
	return false
}

// FileList is what to send from a worktree: git's own list (tracked files and untracked files that are not ignored, from the root), minus a link that leaves the worktree and minus the names that look like secrets, with the
// caps. It never lists what git ignores, and never .git.
func FileList(root string, lim ClientLimits) (FileSet, error) {
	var fs FileSet
	cmd := exec.Command("git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	out, err := cmd.Output()
	if err != nil {
		return fs, fmt.Errorf("heavy: git ls-files: %w", err)
	}
	seen := map[string]bool{}
	var files int
	var total int64
	for _, raw := range bytes.Split(out, []byte{0}) {
		name := string(raw)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		if _, err := cleanName(name); err != nil {
			fs.Skipped = append(fs.Skipped, Skip{name, "a name that cannot be sent"})
			continue
		}
		fi, err := os.Lstat(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			continue // listed but gone (a deleted tracked file)
		}
		switch {
		case fi.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(filepath.Join(root, filepath.FromSlash(name)))
			if err != nil || linkTarget(name, target) != nil {
				fs.Skipped = append(fs.Skipped, Skip{name, "a link that leaves the worktree"})
				continue
			}
			fs.Send = append(fs.Send, FileEntry{Name: name, Link: target, IsLink: true})
		case fi.Mode().IsRegular():
			if looksSecret(path.Base(name)) {
				fs.Skipped = append(fs.Skipped, Skip{name, "a name that looks like a secret"})
				continue
			}
			fs.Send = append(fs.Send, FileEntry{Name: name, Size: fi.Size(), Exec: fi.Mode()&0o100 != 0})
			files++
			total += fi.Size()
		default:
			fs.Skipped = append(fs.Skipped, Skip{name, "not a plain file"})
		}
	}
	if files > lim.Files || total > lim.Bytes {
		return fs, fmt.Errorf("%w: %d files, %d bytes (the caps are %d files, %d bytes): run it on the Mac, or send less", ErrTooBig, files, total, lim.Files, lim.Bytes)
	}
	fs.Bytes = total
	sort.Slice(fs.Skipped, func(i, j int) bool { return fs.Skipped[i].Name < fs.Skipped[j].Name })
	return fs, nil
}

// WriteStream writes the header and then the plain tar of the files, as the wrapper reads them. It does not close w: the connection stays open for as long as the command runs (its end ending is how the wrapper learns of a drop).
func WriteStream(w io.Writer, h Header, root string, fs FileSet) error {
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(raw)))
	if _, err := io.WriteString(w, Magic); err != nil {
		return err
	}
	if _, err := w.Write(append(n[:], raw...)); err != nil {
		return err
	}
	tw := tar.NewWriter(w)
	for _, e := range fs.Send {
		if e.IsLink {
			if err := tw.WriteHeader(&tar.Header{Name: e.Name, Typeflag: tar.TypeSymlink, Linkname: e.Link, Mode: 0o777}); err != nil {
				return err
			}
			continue
		}
		mode := int64(0o644)
		if e.Exec {
			mode = 0o755
		}
		f, err := os.Open(filepath.Join(root, filepath.FromSlash(e.Name)))
		if err != nil {
			return err
		}
		if err := tw.WriteHeader(&tar.Header{Name: e.Name, Typeflag: tar.TypeReg, Mode: mode, Size: e.Size}); err != nil {
			f.Close()
			return err
		}
		_, cerr := io.CopyN(tw, f, e.Size)
		f.Close()
		if cerr != nil {
			return fmt.Errorf("heavy: %s changed while it was read: %w", e.Name, cerr)
		}
	}
	return tw.Close()
}

var aliasRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)

// SSHArgs is the whole ssh command line after "ssh": fixed options and the Operator's alias after "--". The alias names a Host block the Operator wrote in their own ssh config (address, user, key, pinned host key); nothing
// about the destination comes from an agent, a resource or the command. No terminal, no agent or X11 forwarding, no port forwards, no environment sent.
func SSHArgs(alias string) ([]string, error) {
	if !aliasRe.MatchString(alias) {
		return nil, fmt.Errorf("heavy: %q is not an ssh alias name (lower case letters, digits and dashes, starting with a letter)", alias)
	}
	return []string{
		"-T", "-a", "-x",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "PermitLocalCommand=no",
		"-o", "SendEnv=-*",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=3",
		"-o", "ConnectTimeout=15",
		"--", alias,
	}, nil
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slug is an agent's name as a run folder name: lower case letters, digits and dashes.
func Slug(name string) string {
	s := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-")
	}
	if s == "" {
		return "agent"
	}
	return s
}

// TrailerReader passes a stream through and takes out the wrapper's last line. The line only counts as the wrapper's when nothing follows it: a program that prints one in the middle of its output does not set the exit code.
type TrailerReader struct {
	W       io.Writer
	buf     []byte
	pending string // the last trailer-looking line, valid while nothing has come after it
	has     bool
}

// Write implements io.Writer.
func (t *TrailerReader) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	for {
		i := bytes.IndexByte(t.buf, '\n')
		if i < 0 {
			break
		}
		line := string(t.buf[:i])
		t.buf = t.buf[i+1:]
		if strings.HasPrefix(line, Trailer) {
			t.pending, t.has = strings.TrimPrefix(line, Trailer), true
			continue
		}
		t.has = false // something came after it
		if _, err := io.WriteString(t.W, line+"\n"); err != nil {
			return 0, err
		}
	}
	if len(t.buf) > 0 && !strings.HasPrefix(Trailer, string(t.buf)) && !strings.HasPrefix(string(t.buf), Trailer) {
		t.has = false
	}
	return len(p), nil
}

// Flush passes on what is left without a newline.
func (t *TrailerReader) Flush() {
	if len(t.buf) > 0 && !strings.HasPrefix(string(t.buf), Trailer) {
		t.has = false
		_, _ = t.W.Write(t.buf)
	}
	t.buf = nil
}

// Trailer is the wrapper's last line ("exit 3", "killed: time cap", "refused: ..."), or "" when the stream did not end with one: ssh itself failed or the connection dropped.
func (t *TrailerReader) Trailer() string {
	if t.has {
		return t.pending
	}
	return ""
}

// Conn is a way to the wrapper: ssh, or in tests a pipe into the wrapper itself.
type Conn struct {
	Stdin          io.WriteCloser
	Stdout, Stderr io.Reader
	Wait           func() error
}

// Transport starts a Conn.
type Transport func(ctx context.Context) (Conn, error)

// SSHTransport runs ssh with the fixed arguments to the Operator's alias.
func SSHTransport(alias string) (Transport, error) {
	args, err := SSHArgs(alias)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context) (Conn, error) {
		cmd := exec.CommandContext(ctx, "ssh", args...)
		in, err := cmd.StdinPipe()
		if err != nil {
			return Conn{}, err
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			return Conn{}, err
		}
		er, err := cmd.StderrPipe()
		if err != nil {
			return Conn{}, err
		}
		if err := cmd.Start(); err != nil {
			return Conn{}, err
		}
		return Conn{Stdin: in, Stdout: out, Stderr: er, Wait: cmd.Wait}, nil
	}, nil
}

// Exit codes the client returns besides the command's own.
const ExitConnection = 255 // ssh, not the command: the connection failed or ended before the command said how it ended

// RunOptions is one remote run.
type RunOptions struct {
	Worktree   string // the repository's top folder
	Subdir     string // where under it the command runs ("" or a clean relative path)
	Command    string // a shell command line
	Agent      string // the agent's name, slugged for the run folder
	MaxSeconds int
	Env        map[string]string
	Limits     ClientLimits
	Out, Err   io.Writer
	Transport  Transport
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// Run sends the worktree, runs the command on the other machine, streams its output and returns its exit code (ExitConnection when ssh failed; ExitRefused or ExitKilled with the wrapper's reason said).
func Run(ctx context.Context, o RunOptions) (int, error) {
	if o.Limits.Files == 0 {
		o.Limits = DefaultClientLimits
	}
	fs, err := FileList(o.Worktree, o.Limits)
	if err != nil {
		return 0, err
	}
	for _, s := range fs.Skipped {
		fmt.Fprintf(o.Err, "[heavy] left out %s: %s\n", s.Name, s.Why)
	}
	var rb [16]byte
	if _, err := rand.Read(rb[:]); err != nil {
		return 0, err
	}
	command := o.Command
	if o.Subdir != "" && o.Subdir != "." {
		clean := path.Clean(filepath.ToSlash(o.Subdir))
		if strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
			return 0, fmt.Errorf("heavy: the folder %q is not inside the worktree", o.Subdir)
		}
		command = "cd " + shellQuote(clean) + " && " + command
	}
	h := Header{Agent: Slug(o.Agent), Run: hex.EncodeToString(rb[:]), Command: command, MaxSeconds: o.MaxSeconds, Files: len(fs.Send) + 16, Bytes: fs.Bytes + 1<<20, Env: o.Env}
	conn, err := o.Transport(ctx)
	if err != nil {
		return ExitConnection, fmt.Errorf("heavy: starting the connection: %w", err)
	}
	var wg sync.WaitGroup
	var sendErr error
	wg.Add(3)
	go func() { // the archive; the connection then stays open for as long as the command runs
		defer wg.Done()
		sendErr = WriteStream(conn.Stdin, h, o.Worktree, fs)
	}()
	go func() { defer wg.Done(); _, _ = io.Copy(o.Out, conn.Stdout) }()
	tr := &TrailerReader{W: o.Err}
	go func() { defer wg.Done(); _, _ = io.Copy(tr, conn.Stderr); tr.Flush() }()
	// the output ends when the wrapper (and so ssh) ends
	outDone := make(chan struct{})
	go func() { wg.Wait(); close(outDone) }()
	var waitErr error
	waitDone := make(chan struct{})
	go func() { waitErr = conn.Wait(); close(waitDone) }()
	<-waitDone
	_ = conn.Stdin.Close()
	<-outDone
	tail := tr.Trailer()
	switch {
	case strings.HasPrefix(tail, "exit "):
		var code int
		if _, err := fmt.Sscanf(tail, "exit %d", &code); err == nil {
			return code, nil
		}
	case strings.HasPrefix(tail, "killed: "):
		fmt.Fprintf(o.Err, "[heavy] the other machine stopped the command: %s\n", strings.TrimPrefix(tail, "killed: "))
		return ExitKilled, nil
	case strings.HasPrefix(tail, "refused: "):
		fmt.Fprintf(o.Err, "[heavy] the other machine refused to run it: %s\n", strings.TrimPrefix(tail, "refused: "))
		return ExitRefused, nil
	}
	why := "the connection ended before the command said how it ended"
	if waitErr != nil {
		why += " (ssh: " + waitErr.Error() + ")"
	}
	if sendErr != nil && !errors.Is(sendErr, io.ErrClosedPipe) {
		why += " (sending: " + sendErr.Error() + ")"
	}
	fmt.Fprintf(o.Err, "[heavy] connection problem, not the command's exit code: %s\n", why)
	return ExitConnection, nil
}
