// Package foldertrust marks a folder trusted for an agent's CLI so that its "trust this folder" card does not appear (#11889, the Operator's decision: launching a team in the folder the person chose counts as
// trusting it for the team's agents), under Security's conditions. What trust means: a trusted folder lets the repository in it run its own settings hooks, MCP servers and helpers with no card, so trusting a folder
// that holds someone else's code is running that code. Therefore:
//   - Check decides which folders may be trusted: one Coral made in this launch (Made), or an existing one the person ticked by name (Ticked); never an existing one without the tick (Existing), the home folder or a
//     parent of it, a filesystem root, a hidden folder under home (credentials live there), or a direct child of home unless Coral made it (trust is inherited by subfolders: ~/Documents would cover every repo in it).
//     The path is resolved first, and the resolved path is what is checked and trusted.
//   - TrustClaude and TrustCodex each write one entry and nothing else, through a private temp file and an atomic rename, never over a link, never an entry the person turned down, and leave the card (an error)
//     on any doubt. Neither logs what it read.
//
// This guards against a mistake, not against an agent that chooses to edit these files: it runs as the same user.
package foldertrust

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/subgentic/coral/internal/fsreplace"
)

// Basis is why a folder may be trusted.
type Basis int

const (
	// Existing: a folder that was there already, with no tick: never trusted.
	Existing Basis = iota
	// Ticked: an existing folder the person ticked "Trust this folder" for, naming the path.
	Ticked
	// Made: a folder Coral made in this launch (the default ~/Coral/<name>).
	Made
)

var (
	ErrNotTicked = errors.New("an existing folder is trusted only when the person ticks it")
	ErrDeclined  = errors.New("the person turned trust down for this folder")
	ErrNoConfig  = errors.New("the agent's settings file is not there yet")
	ErrLinked    = errors.New("the agent's settings file is a link")
)

// maxConfigBytes caps what is read of an agent's settings file (Claude's .claude.json grows with its history).
const maxConfigBytes = 8 << 20

// Check says whether path may be trusted for basis, and answers the resolved folder that would be.
func Check(path, home string, basis Basis) (string, error) {
	if path == "" || !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\n\r") {
		return "", errors.New("the folder is not a plain absolute path")
	}
	realPath, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("the folder cannot be resolved: %w", err)
	}
	if fi, err := os.Stat(realPath); err != nil || !fi.IsDir() {
		return "", errors.New("the folder is not an existing folder")
	}
	if realPath == filepath.Dir(realPath) {
		return "", errors.New("a filesystem root is never trusted")
	}
	if home == "" {
		return "", errors.New("the home folder is not known")
	}
	realHome, err := filepath.EvalSymlinks(filepath.Clean(home))
	if err != nil {
		return "", fmt.Errorf("the home folder cannot be resolved: %w", err)
	}
	rel, err := filepath.Rel(realPath, realHome) // home inside or equal to path: path is home or a parent of it
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("the home folder, or a folder that holds it, is never trusted")
	}
	if inside, err := filepath.Rel(realHome, realPath); err == nil && inside != ".." && !strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		parts := strings.Split(inside, string(filepath.Separator))
		if strings.HasPrefix(parts[0], ".") {
			return "", errors.New("a hidden folder under home (where agents keep their settings and logins) is never trusted")
		}
		if len(parts) == 1 && basis != Made {
			return "", errors.New("a direct child of the home folder would trust every repository the person puts under it")
		}
	} else {
		// Outside home: the folder may be one other people on the computer can write into. A shared root (/tmp, /Users/Shared), a shallow folder (/srv/x, /Volumes/Backup) and a folder that group or others can
		// write are refused: whoever can write there can plant the settings, hooks and tools that trust would run with no card (Security's SHOULD on #11889).
		if why := sharedOrShallow(realPath); why != "" {
			return "", errors.New(why)
		}
		if fi, err := os.Stat(realPath); err == nil && runtime.GOOS != "windows" && fi.Mode().Perm()&0o022 != 0 {
			return "", errors.New("a folder outside home that group or others can write into is never trusted")
		}
	}
	switch basis {
	case Made, Ticked:
		return realPath, nil
	}
	return "", ErrNotTicked
}

// readConfig reads an agent's settings file: a regular file that is not a link, at most maxConfigBytes, and its mode.
func readConfig(path string) ([]byte, os.FileMode, error) {
	fi, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, ErrNoConfig
	}
	if err != nil {
		return nil, 0, err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, 0, ErrLinked
	}
	if !fi.Mode().IsRegular() {
		return nil, 0, errors.New("the agent's settings file is not a regular file")
	}
	if fi.Size() > maxConfigBytes {
		return nil, 0, errors.New("the agent's settings file is too large to change safely")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if len(b) > maxConfigBytes {
		return nil, 0, errors.New("the agent's settings file is too large to change safely")
	}
	return b, fi.Mode().Perm(), nil
}

// replaceFile writes data over path through a temp file made 0600 in the same folder, brought to mode and renamed: a reader sees the old file or the new one, and a failure leaves the old one.
func replaceFile(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".foldertrust-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil && !errors.Is(err, os.ErrPermission) {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return fsreplace.Rename(f.Name(), path)
}

// marshalRaw is v as indented JSON as Claude writes it, without escaping what the raw values hold.
func marshalRaw(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// TrustClaude sets projects["<path>"].hasTrustDialogAccepted to true in Claude's settings file at cfg (.claude.json), and reports whether it wrote anything. The values of the file are kept as raw JSON, so a number
// or a string comes out as it went in (the order of an object's keys may change: JSON does not order them). The file must exist (Claude makes it; absent, the card stays), must be a regular file and not a link, and
// an entry that says false (the person's own answer) or anything other than a boolean is left alone with an error.
func TrustClaude(cfg, path string) (bool, error) {
	raw, mode, err := readConfig(cfg)
	if err != nil {
		return false, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return false, errors.New("the settings file is not a JSON object")
	}
	projects := map[string]json.RawMessage{}
	if p, ok := top["projects"]; ok {
		if err := json.Unmarshal(p, &projects); err != nil || projects == nil {
			return false, errors.New("the settings file's projects is not an object")
		}
	}
	entry := map[string]json.RawMessage{}
	if e, ok := projects[path]; ok {
		if err := json.Unmarshal(e, &entry); err != nil || entry == nil {
			return false, errors.New("the folder's entry is not an object")
		}
	}
	if cur, ok := entry["hasTrustDialogAccepted"]; ok {
		var b bool
		if err := json.Unmarshal(cur, &b); err != nil {
			return false, errors.New("the folder's trust flag is not a boolean")
		}
		if b {
			return false, nil
		}
		return false, ErrDeclined
	}
	entry["hasTrustDialogAccepted"] = json.RawMessage("true")
	eb, err := marshalRaw(entry)
	if err != nil {
		return false, err
	}
	projects[path] = eb
	pb, err := marshalRaw(projects)
	if err != nil {
		return false, err
	}
	top["projects"] = pb
	out, err := marshalRaw(top)
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(out, &map[string]json.RawMessage{}); err != nil {
		return false, err
	}
	if err := replaceFile(cfg, append(out, '\n'), mode); err != nil {
		return false, err
	}
	verify, _, err := readConfig(cfg)
	if err != nil || !bytes.Equal(bytes.TrimSpace(verify), bytes.TrimSpace(out)) {
		return false, errors.New("the settings file was changed by something else while it was written")
	}
	return true, nil
}

// codexTableKey is the folder as the key of a [projects.<key>] table in Codex's config.toml. A path with a quote or a control character is refused everywhere. A backslash is refused except on Windows, where it
// is the separator of every path: there the key is a TOML literal string ('C:\Users\x'), which takes no escapes, so nothing in the path can end it early; a path with a single quote is then refused too (#12266).
func codexTableKey(path string, windows bool) (string, error) {
	unsafe := errors.New("the folder's name has a character that cannot be written safely in Codex's settings")
	for _, r := range path {
		if r == '"' || r < 0x20 || r == 0x7f {
			return "", unsafe
		}
		if r == '\\' && !windows {
			return "", unsafe
		}
		if r == '\'' && windows {
			return "", unsafe
		}
	}
	if windows && strings.ContainsRune(path, '\\') {
		return "'" + path + "'", nil
	}
	return "\"" + path + "\"", nil
}

// TrustCodex appends [projects."<path>"] trust_level = "trusted" to Codex's config.toml at cfg and reports whether it wrote anything. Nothing that was there is touched: the table is appended to the text,
// and only after the file with it appended parses as TOML again with the one entry (an inline projects table, a projects that is not a table, or a file that does not parse leave the card, since an invalid
// config.toml stops Codex). A path with a quote, backslash or control character is refused; a table for the same folder in any spelling (a trailing slash) or an answer other than trusted is left alone. An absent
// file is made, 0600, with the table.
func TrustCodex(cfg, path string) (bool, error) {
	key, err := codexTableKey(path, runtime.GOOS == "windows")
	if err != nil {
		return false, err
	}
	existing, mode := []byte(nil), os.FileMode(0o600)
	if b, m, err := readConfig(cfg); err == nil {
		existing, mode = b, m
	} else if !errors.Is(err, ErrNoConfig) {
		return false, err
	}
	var parsed map[string]any
	if len(existing) > 0 {
		if err := toml.Unmarshal(existing, &parsed); err != nil {
			return false, errors.New("Codex's settings file does not parse")
		}
	}
	if p, ok := parsed["projects"]; ok {
		table, isTable := p.(map[string]any)
		if !isTable {
			return false, errors.New("Codex's settings file has projects as something other than a table")
		}
		for key, v := range table {
			if filepath.Clean(key) != filepath.Clean(path) {
				continue
			}
			if m, ok := v.(map[string]any); ok && m["trust_level"] == "trusted" {
				return false, nil
			}
			return false, ErrDeclined
		}
	}
	add := fmt.Sprintf("[projects.%s]\ntrust_level = \"trusted\"\n", key)
	text := append([]byte(nil), existing...)
	if len(text) > 0 && !bytes.HasSuffix(text, []byte("\n")) {
		text = append(text, '\n')
	}
	if len(text) > 0 {
		text = append(text, '\n')
	}
	text = append(text, add...)
	var check map[string]any
	if err := toml.Unmarshal(text, &check); err != nil {
		return false, errors.New("the table could not be added without breaking Codex's settings file")
	}
	if tbl, _ := check["projects"].(map[string]any); tbl == nil || func() bool { m, _ := tbl[path].(map[string]any); return m["trust_level"] != "trusted" }() {
		return false, errors.New("the table did not come out as written")
	}
	if err := replaceFile(cfg, text, mode); err != nil {
		return false, err
	}
	return true, nil
}

// sharedRoots are the folders anyone on the computer can write into, at any depth below them.
var sharedRoots = []string{"/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/Users/Shared"}

// sharedOrShallow says why a folder outside home is too shared or too shallow to trust ("" when it is neither): under a shared root, or with fewer than three components (/srv/x, /Volumes/Backup, /usr/local):
// a folder that shallow is a root of its own that other people's work lives in.
func sharedOrShallow(p string) string {
	slash := filepath.ToSlash(p)
	for _, root := range sharedRoots {
		if slash == root || strings.HasPrefix(slash, root+"/") {
			return "a folder in a shared place (" + root + ") is never trusted: anyone on the computer can write into it"
		}
	}
	rest := strings.Trim(strings.TrimPrefix(slash, filepath.VolumeName(p)), "/")
	if rest == "" || len(strings.Split(rest, "/")) < 3 {
		return "a folder this close to the root of a disk is never trusted: other people's work lives beside it"
	}
	return ""
}
