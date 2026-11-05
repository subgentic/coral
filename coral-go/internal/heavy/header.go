package heavy

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
)

// The stream the wrapper reads from its stdin: Magic, a four-byte big-endian length, that many bytes of JSON (the Header), then a plain tar archive to the end. Nothing comes from the command line or SSH_ORIGINAL_COMMAND.
const (
	Magic      = "CORAL-HEAVY/1\n"
	MaxHeader  = 16 << 10         // the header's length, a cap of the wrapper's own
	MaxCommand = 8192             // the command's length
	Trailer    = "[coral-heavy] " // a line the wrapper writes to stderr last: "exit N", "killed: why" or "refused: why"

	DefaultFiles   = 50000
	DefaultBytes   = 512 << 20
	DefaultSeconds = 7200 // the hard cap: twice the longest lease

	ExitRefused = 125 // the wrapper would not run it
	ExitKilled  = 124 // the wrapper stopped it (a time cap, the connection)
)

// Header is what a run says of itself. Every cap in it may only LOWER the wrapper's own.
type Header struct {
	Agent      string            `json:"agent"`   // a slug of the agent's name
	Run        string            `json:"run"`     // 32 lower-case hex, random
	Command    string            `json:"command"` // run by sh -c in the run folder
	MaxSeconds int               `json:"max_seconds,omitempty"`
	Files      int               `json:"files,omitempty"`
	Bytes      int64             `json:"bytes,omitempty"`
	Env        map[string]string `json:"env,omitempty"` // only names on EnvAllowed
}

// EnvAllowed are the only variables a run may ask for besides the wrapper's own: what a test needs, never anything of the caller's environment.
var EnvAllowed = []string{"CDP_FULL", "NO_COLOR", "GOMAXPROCS", "CORAL_RESOURCE_HOOK_PORT"}

var errHeader = errors.New("heavy: bad header")

func hf(format string, a ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{errHeader}, a...)...)
}

// ReadHeader reads and checks the header from the start of a stream.
func ReadHeader(r io.Reader) (Header, error) {
	var h Header
	magic := make([]byte, len(Magic))
	if _, err := io.ReadFull(r, magic); err != nil || string(magic) != Magic {
		return h, hf("not a heavy-run stream")
	}
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return h, hf("no length")
	}
	size := binary.BigEndian.Uint32(n[:])
	if size == 0 || size > MaxHeader {
		return h, hf("the header is %d bytes (the cap is %d)", size, MaxHeader)
	}
	raw := make([]byte, size)
	if _, err := io.ReadFull(r, raw); err != nil {
		return h, hf("the header is cut short")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&h); err != nil {
		return h, hf("%v", err)
	}
	if !ValidAgent(h.Agent) {
		return h, hf("the agent name")
	}
	if !ValidRun(h.Run) {
		return h, hf("the run id")
	}
	if h.Command == "" || len(h.Command) > MaxCommand || strings.ContainsRune(h.Command, 0) {
		return h, hf("the command is empty, over %d bytes or has a NUL", MaxCommand)
	}
	if h.MaxSeconds < 0 || h.Files < 0 || h.Bytes < 0 {
		return h, hf("a negative cap")
	}
	for k, v := range h.Env {
		ok := false
		for _, a := range EnvAllowed {
			ok = ok || a == k
		}
		if !ok || len(v) > 200 || strings.ContainsAny(v, "\x00\n\r") {
			return h, hf("the variable %q", k)
		}
	}
	return h, nil
}

// Environ is the whole environment of a run: an ALLOWLIST. Nothing of the wrapper's own environment is passed (a denylist misses whatever is added next): PATH, HOME, LANG, TERM, a temp folder inside the run folder, the
// isolation variables, and the few names the header may ask for.
func Environ(home, runDir string, extra map[string]string) []string {
	path := strings.Join([]string{filepath.Join(home, ".local", "go", "bin"), filepath.Join(home, ".local", "node", "bin"), filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}, ":")
	env := []string{"PATH=" + path, "HOME=" + home, "LANG=en_US.UTF-8", "TERM=dumb", "TMPDIR=" + filepath.Join(runDir, "tmp"), "CORAL_DATA_DIR=" + runDir, "CORAL_TELEMETRY_DISABLED=1", "CORAL_HEAVY_RUN=1"}
	var names []string
	for k := range extra {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		env = append(env, k+"="+extra[k])
	}
	return env
}
