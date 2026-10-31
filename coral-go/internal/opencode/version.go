package opencode

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Version is an opencode build's version, as `opencode --version` prints it. Coral supports the public 1.x release (its server reads OPENCODE_SERVER_PASSWORD and its TUI attaches with `opencode attach <url>`) and
// 2.x (OPENCODE_PASSWORD, `opencode --server <url>`); a later major is run as 2.x with both password variables set.
type Version struct{ Major, Minor, Patch int }

var versionRe = regexp.MustCompile(`^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$`)

// ParseVersion reads a version STRICTLY: "1.19.5" and nothing else (no prefix, no suffix, no second line). Anything else is an error, and a launch that cannot tell what it launches does not go on.
func ParseVersion(s string) (Version, error) {
	m := versionRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return Version{}, fmt.Errorf("opencode: %q is not a version (x.y.z)", truncate(s, 40))
	}
	var v Version
	v.Major, _ = strconv.Atoi(m[1])
	v.Minor, _ = strconv.Atoi(m[2])
	v.Patch, _ = strconv.Atoi(m[3])
	if v.Major < 1 {
		return Version{}, fmt.Errorf("opencode: version %s is older than anything Coral supports (1.x)", strings.TrimSpace(s))
	}
	return v, nil
}

func truncate(s string, n int) string {
	s = strings.ToValidUTF8(s, "")
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// PasswordVars are the environment variables an opencode server of this major version reads its password from, and the TUI that attaches to it: 1.x reads OPENCODE_SERVER_PASSWORD and ignores
// OPENCODE_PASSWORD (a server given only that one is OPEN: it answers 200 to no password at all); 2.x reads OPENCODE_PASSWORD. A later major, not yet seen, gets both: setting a variable the build does not
// read is harmless, and the readiness probe (a wrong password first, never trusting a 200) still refuses a server that ignored both.
func PasswordVars(major int) []string {
	switch {
	case major == 1:
		return []string{"OPENCODE_SERVER_PASSWORD"}
	default:
		return []string{"OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"}
	}
}

// AttachesWithSubcommand says how the TUI is aimed at a server: 1.x with `opencode attach <url>`, later with `opencode --server <url>`.
func AttachesWithSubcommand(major int) bool { return major == 1 }

var (
	versionMu    sync.Mutex
	versionCache = map[string]Version{}
)

// DetectVersion runs `bin --version` (in Coral's own opencode environment, bounded to 10 s) and parses what it prints strictly. The answer is kept for the binary's path, size and modification time.
func DetectVersion(ctx context.Context, bin, dataDir string) (Version, error) {
	path, err := exec.LookPath(bin)
	if err != nil {
		return Version{}, fmt.Errorf("opencode: %w", err)
	}
	key := path
	if fi, err := os.Stat(path); err == nil {
		key = fmt.Sprintf("%s\x00%d\x00%d", path, fi.Size(), fi.ModTime().UnixNano())
	}
	versionMu.Lock()
	if v, ok := versionCache[key]; ok {
		versionMu.Unlock()
		return v, nil
	}
	versionMu.Unlock()
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, path, "--version")
	cmd.Env = ToolEnv(os.Environ(), dataDir)
	cmd.Dir = dataDir
	out, err := cmd.Output()
	if err != nil {
		return Version{}, fmt.Errorf("opencode: could not run --version: %w", err)
	}
	v, err := ParseVersion(string(out))
	if err != nil {
		return Version{}, err
	}
	versionMu.Lock()
	versionCache[key] = v
	versionMu.Unlock()
	return v, nil
}
