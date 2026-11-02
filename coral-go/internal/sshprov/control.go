package sshprov

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// Sharing one SSH connection per far computer (#12221). Every hub ssh used to be a full handshake (0.36 s to a computer a few milliseconds away), and the stream target starts one per connection, so a page
// that opens a dozen requests waited on a dozen handshakes. With ControlMaster=auto the first ssh to a computer authenticates, stays up for controlPersist seconds after its last use, and every other ssh
// to it rides that session (0.05 s). The host key is still checked by the master that makes the session, against the hub's own known_hosts as before; nothing else about the options changes.
//
// The socket is a file the hub user alone can use: a folder under the hub's data folder (or, when that path is too long for a Unix socket's name, under /tmp), made 0700, owned by this user and not a link,
// checked before it is trusted. Anything else turns sharing off and every ssh is its own session again, as before. The host-key scan never shares: it must see the key the computer shows now.

// controlPersist is how long the shared session stays up with nothing on it.
const controlPersist = 60

// controlDir is the folder the sockets are in; "" means no sharing (never set, not a supported system, or the folder could not be made safe).
var controlDir atomic.Value

// maxSocketPath is what a Unix socket's path may be (104 on macOS, 108 on Linux), less ssh's temporary name beside the socket ("." and 16 characters) and %C's 40 hex digits.
const maxSocketPath = 100

// UseControlDir turns sharing on with sockets in dir (the hub's data folder's own subfolder), and returns the folder it settled on, "" when sharing stays off.
func UseControlDir(dir string) string {
	controlDir.Store("")
	if runtime.GOOS == "windows" || dir == "" || !filepath.IsAbs(dir) {
		return ""
	}
	for _, d := range []string{dir, shortControlDir(dir)} {
		if d == "" || strings.ContainsAny(d, " \t\"'\\") || len(d)+1+40+17 > maxSocketPath {
			continue
		}
		if err := ensurePrivateDir(d); err != nil {
			continue
		}
		controlDir.Store(d)
		return d
	}
	return ""
}

// shortControlDir is the fallback under /tmp, one per hub data folder (two hubs of one user keep their own host-key files, so they must not share a session): short enough for a socket's name.
func shortControlDir(dir string) string {
	sum := sha256.Sum256([]byte(dir))
	return fmt.Sprintf("/tmp/coral-ssh-%d-%s", os.Getuid(), hex.EncodeToString(sum[:4]))
}

// controlArgs are the options that share the session, or nothing when sharing is off.
func controlArgs() []string {
	d, _ := controlDir.Load().(string)
	if d == "" {
		return nil
	}
	return []string{"-o", "ControlMaster=auto", "-o", "ControlPath=" + filepath.Join(d, "%C"), "-o", fmt.Sprintf("ControlPersist=%d", controlPersist)}
}

// CloseShared ends what was made to t under a host key that is being forgotten, so none of it is used again: the idle `ssh -W` streams of the hub's stream targets for t (they live 5 minutes whether or not
// sessions are shared, #12475), and the shared session, if there is one (`ssh -O exit` with the same options, so it names the same socket; it would otherwise live controlPersist seconds). Best effort;
// the session part is nothing when sharing is off, and an answer of "no session" is not an error.
func (r Runner) CloseShared(ctx context.Context, t Target) {
	closeStreamsTo(t)
	if len(controlArgs()) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ssh := r.SSH
	if ssh == "" {
		ssh = "ssh"
	}
	argv := append(r.baseArgv(t), "-O", "exit", "--", t.Destination())
	cmd := executil.Command(ctx, ssh, argv...)
	cmd.Env = minimalEnv()
	_ = cmd.Run()
}
