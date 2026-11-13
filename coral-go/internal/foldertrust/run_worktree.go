package foldertrust

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// A scheduled job whose person ticked "Trust this folder" trusts exactly the worktree each of its runs made for itself (#16421, Security's conditions on the job's tick). That folder sits under Coral's own data
// folder (~/.coral/worktrees/job-run-<id>-<repo>), a hidden folder that Check refuses on purpose for every other caller, so this is a separate, narrow function that skips only the hidden and shallow rules: it
// takes the one folder that is directly inside the worktrees root, never the root, the repository or a parent (trust is inherited by subfolders), and keeps the link and group/other-writable refusals.

// ClaudeConfigPath is Claude's settings file: $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json.
func ClaudeConfigPath(home string) string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, ".claude.json")
	}
	return filepath.Join(home, ".claude.json")
}

// CodexConfigPath is Codex's config: $CODEX_HOME/config.toml, else ~/.codex/config.toml.
func CodexConfigPath(home string) string {
	if d := os.Getenv("CODEX_HOME"); d != "" {
		return filepath.Join(d, "config.toml")
	}
	return filepath.Join(home, ".codex", "config.toml")
}

// CheckRunWorktree answers the resolved folder of a run's own worktree when it may be trusted: runDir exists, is a real folder (not a link, once resolved), is exactly one level inside worktreesRoot (both
// resolved), and is not writable by group or others. Anything else is refused, and nothing is trusted.
func CheckRunWorktree(runDir, worktreesRoot string) (string, error) {
	if runDir == "" || worktreesRoot == "" || !filepath.IsAbs(runDir) || !filepath.IsAbs(worktreesRoot) || strings.ContainsAny(runDir, "\x00\n\r") {
		return "", refuse(plainFind, "the run's folder is not a plain absolute path")
	}
	if fi, err := os.Lstat(filepath.Clean(runDir)); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return "", refuse(plainFind, "the run's folder is not a real folder")
	}
	realDir, err := filepath.EvalSymlinks(filepath.Clean(runDir))
	if err != nil {
		return "", refuse(plainFind, "the run's folder cannot be resolved")
	}
	realRoot, err := filepath.EvalSymlinks(filepath.Clean(worktreesRoot))
	if err != nil {
		return "", refuse(plainFind, "the worktrees folder cannot be resolved")
	}
	if filepath.Dir(realDir) != realRoot || realDir == realRoot {
		return "", refuse(plainShared, "the folder is not one run's own folder directly inside the worktrees folder")
	}
	if fi, err := os.Stat(realDir); err != nil || !fi.IsDir() {
		return "", refuse(plainFind, "the run's folder is not an existing folder")
	} else if runtime.GOOS != "windows" && fi.Mode().Perm()&0o022 != 0 {
		return "", refuse(plainShared, "a folder that group or others can write into is never trusted")
	}
	return realDir, nil
}

// UntrustClaude removes the projects["<path>"] entry of Claude's settings file at cfg, for a run's worktree that is going away, and reports whether it removed one. Only that key goes; the file must be a
// regular file and not a link, and is replaced through a temp file as TrustClaude does. An absent file or entry is not an error.
func UntrustClaude(cfg, path string) (bool, error) {
	raw, mode, err := readConfig(cfg)
	if err != nil {
		if errors.Is(err, ErrNoConfig) {
			return false, nil
		}
		return false, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return false, errors.New("the settings file is not a JSON object")
	}
	var projects map[string]json.RawMessage
	if p, ok := top["projects"]; !ok || json.Unmarshal(p, &projects) != nil || projects == nil {
		return false, nil
	}
	if _, ok := projects[path]; !ok {
		return false, nil
	}
	delete(projects, path)
	pb, err := marshalRaw(projects)
	if err != nil {
		return false, err
	}
	top["projects"] = pb
	out, err := marshalRaw(top)
	if err != nil {
		return false, err
	}
	if err := replaceFile(cfg, append(out, '\n'), mode); err != nil {
		return false, err
	}
	return true, nil
}

// UntrustCodex removes the [projects."<path>"] table TrustCodex added to Codex's config.toml at cfg: exactly its two lines (trust_level = "trusted"), and only if the file still parses afterwards. A table with
// anything else in it, or a file that does not match, is left as it is. It reports whether it removed one.
func UntrustCodex(cfg, path string) (bool, error) {
	key, err := codexTableKey(path, runtime.GOOS == "windows")
	if err != nil {
		return false, err
	}
	existing, mode, err := readConfig(cfg)
	if err != nil {
		if errors.Is(err, ErrNoConfig) {
			return false, nil
		}
		return false, err
	}
	block := []byte(fmt.Sprintf("[projects.%s]\ntrust_level = \"trusted\"\n", key))
	i := bytes.Index(existing, block)
	if i < 0 || (i > 0 && existing[i-1] != '\n') {
		return false, nil
	}
	text := append([]byte(nil), existing[:i]...)
	text = append(text, existing[i+len(block):]...)
	text = bytes.TrimRight(text, "\n")
	if len(text) > 0 {
		text = append(text, '\n')
	}
	var check map[string]any
	if err := toml.Unmarshal(text, &check); err != nil && len(text) > 0 {
		return false, errors.New("the table could not be removed without breaking Codex's settings file")
	}
	if err := replaceFile(cfg, text, mode); err != nil {
		return false, err
	}
	return true, nil
}
