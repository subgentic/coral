// The launch temp files: the files a launch writes for the CLI (prompts, protocol text) in a private folder, and the sweep that removes old ones. Moved out of agent.go (#8334), no code changed.

package agent

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/logsafe"
)

// readProtocolFile reads the protocol file and returns its content, or "" on error.
func readProtocolFile(path string) string {
	if path == "" {
		return ""
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

// shellQuote quotes one word for the platform shell, and ShellJoin builds a launch
// line from parts: shell_quote_unix.go and shell_quote_windows.go.

// joinQuoted quotes every part except those named in raw. callOp prefixes the first
// quoted command word with PowerShell's call operator.
func joinQuoted(parts, raw []string, quote func(string) string, callOp bool) string {
	isRaw := make(map[string]bool, len(raw))
	for _, r := range raw {
		isRaw[r] = true
	}
	out := make([]string, len(parts))
	seenCommand := false
	for i, p := range parts {
		if isRaw[p] {
			out[i] = p
			continue
		}
		q := quote(p)
		if callOp && !seenCommand && q != p {
			q = "& " + q
		}
		seenCommand = true
		out[i] = q
	}
	return strings.Join(out, " ")
}

// writeTempFile creates a temp file with an unpredictable name using os.CreateTemp
// (O_CREATE|O_EXCL) to prevent symlink attacks. The file name includes the session
// ID for later cleanup via CleanupTempFiles. Returns the file path. When the file
// can't be created or fully written it returns an error naming the temp folder: there
// is no fallback to a predictable name in the shared temp folder, which another user
// could plant first, and a half-written file is removed (#3601 W12).
func writeTempFile(prefix, id, ext string, content []byte) (string, error) {
	// The path is typed into the launch line inside $(cat …): the id (a session id,
	// possibly from a request) keeps only safe characters (#3362).
	id = safeFileID(id)
	pattern := fmt.Sprintf("coral_%s_%s_*.%s", prefix, id, ext)
	dir := LaunchTempDir()
	f, err := createTemp(dir, pattern)
	if err != nil {
		return "", fmt.Errorf("can't create the agent's %s file in the temp folder %s: %w", prefix, dir, err)
	}
	_, err = f.Write(content)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", fmt.Errorf("can't write the agent's %s file in the temp folder %s: %w", prefix, dir, err)
	}
	rememberLaunchTemp(id, f.Name())
	return f.Name(), nil
}

// launchFiles collects the temp files one launch command writes. After the first failure
// it writes nothing more, and done removes the files already made and returns the error,
// so a launch never starts without its prompt, settings or instructions.
type launchFiles struct {
	made []string
	dirs []string
	err  error
}

func (l *launchFiles) write(prefix, id, ext string, content []byte) string {
	if l.err != nil {
		return ""
	}
	p, err := writeTempFile(prefix, id, ext, content)
	if err != nil {
		l.err = err
		return ""
	}
	l.made = append(l.made, p)
	return p
}

// dir records a temp folder made for the launch (removed with the files on a failure), or
// the error making it.
func (l *launchFiles) dir(d string, err error) string {
	if l.err != nil {
		if d != "" {
			os.RemoveAll(d)
		}
		return ""
	}
	if err != nil {
		l.err = err
		return ""
	}
	l.dirs = append(l.dirs, d)
	return d
}

func (l *launchFiles) done(cmd string) (string, error) {
	if l.err != nil {
		for _, p := range l.made {
			os.Remove(p)
		}
		for _, d := range l.dirs {
			os.RemoveAll(d)
		}
		return "", l.err
	}
	return cmd, nil
}

// createTemp is os.CreateTemp; tests replace it to make the create or the write fail.
var createTemp = os.CreateTemp

// safeFileID keeps letters, digits, '-' and '_' (a UUID is unchanged); anything else
// becomes '_'.
func safeFileID(id string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, id)
}

// CleanupTempFiles removes the Coral temp files of one session: its prompt and settings files
// (coral_<kind>_<id>[_<random>].<ext>) and agy's hooks folder (coral_agyhooks_<id>_<random>),
// called during teardown so nothing sensitive stays in the temp folder. sessionID must be a
// canonical UUID and each name must carry exactly it (followed by '_', '.' or nothing): a
// glob on an id like "a" matched every other session's files too (weak site W10, #3598).
//
// It removes the paths this process wrote for the session (wherever they are), and the session's
// files in Coral's private launch temp folder (<data dir>/tmp, written before a restart). It
// never reads the system temp folder (#90): files a launch before #4381 left there, or one while
// the private folder couldn't be made before a restart, are the startup sweep's.
func CleanupTempFiles(sessionID string) {
	if !isCanonicalUUID(sessionID) {
		return
	}
	if SessionTokenFileRemover != nil {
		SessionTokenFileRemover(sessionID) // a Codex agent's kept token file (#13 review N2)
	}
	var paths []string
	for _, p := range takeLaunchTemps(sessionID) {
		if inLaunchTempFolder(p) {
			paths = append(paths, p)
		}
	}
	if dir := privateLaunchTempDir(); dir != "" {
		if m, err := filepath.Glob(filepath.Join(dir, "coral_*_"+sessionID+"*")); err == nil {
			paths = append(paths, m...)
		}
	}
	for _, path := range paths {
		base := filepath.Base(path)
		i := strings.Index(base, "_"+sessionID)
		if !strings.HasPrefix(base, "coral_") || i < len("coral_x") {
			continue
		}
		if rest := base[i+1+len(sessionID):]; rest != "" && rest[0] != '_' && rest[0] != '.' {
			continue // another id that starts with this one
		}
		if strings.HasPrefix(base, "coral_agyhooks_") {
			os.RemoveAll(path) // agy's hooks folder (#3481)
			continue
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			slog.Debug("failed to remove temp file", "path", logsafe.Dir(path), "error", err)
		}
	}
}
