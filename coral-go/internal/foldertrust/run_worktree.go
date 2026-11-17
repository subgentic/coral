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

	"github.com/subgentic/coral/internal/coralnames"
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

// AgyConfigPath is Antigravity's settings file: ~/.gemini/antigravity-cli/settings.json.
func AgyConfigPath(home string) string {
	return filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
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

// writeSettings is replaceFile; the tests count its calls.
var writeSettings = replaceFile

// UntrustClaude removes the projects["<path>"] entry of Claude's settings file at cfg, for a run's worktree that is going away, and reports whether it removed one. Only that key goes; the file must be a
// regular file and not a link, and is replaced through a temp file as TrustClaude does. An absent file or entry is not an error.
func UntrustClaude(cfg, path string) (bool, error) {
	n, err := untrustClaudeKeys(cfg, []string{path})
	return n > 0, err
}

// untrustClaudeKeys removes each of keys from projects in one read and one write of the file (none present: no write), and returns how many were there.
func untrustClaudeKeys(cfg string, keys []string) (int, error) {
	raw, mode, err := readConfig(cfg)
	if err != nil {
		if errors.Is(err, ErrNoConfig) {
			return 0, nil
		}
		return 0, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return 0, errors.New("the settings file is not a JSON object")
	}
	var projects map[string]json.RawMessage
	if p, ok := top["projects"]; !ok || json.Unmarshal(p, &projects) != nil || projects == nil {
		return 0, nil
	}
	n := 0
	for _, k := range keys {
		if _, ok := projects[k]; ok {
			delete(projects, k)
			n++
		}
	}
	if n == 0 {
		return 0, nil
	}
	pb, err := marshalRaw(projects)
	if err != nil {
		return 0, err
	}
	top["projects"] = pb
	out, err := marshalRaw(top)
	if err != nil {
		return 0, err
	}
	if err := writeSettings(cfg, append(out, '\n'), mode); err != nil {
		return 0, err
	}
	return n, nil
}

// UntrustAgy removes path from the trustedWorkspaces list of Antigravity's settings file at cfg, for a run's worktree that is going away (#19176), and reports whether it removed one. The other values are kept
// as raw JSON; an absent file, a file that is not a JSON object or has no such list, or a path not in it, is left as it is. The file is replaced through a temp file as TrustAgy does.
func UntrustAgy(cfg, path string) (bool, error) {
	n, err := untrustAgyKeys(cfg, []string{path})
	return n > 0, err
}

// untrustAgyKeys removes each of keys from trustedWorkspaces in one read and one write (none present: no write), and returns how many were there.
func untrustAgyKeys(cfg string, keys []string) (int, error) {
	raw, mode, err := readConfig(cfg)
	if err != nil {
		if errors.Is(err, ErrNoConfig) {
			return 0, nil
		}
		return 0, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return 0, errors.New("the settings file is not a JSON object")
	}
	var list []string
	if cur, ok := top["trustedWorkspaces"]; !ok || json.Unmarshal(cur, &list) != nil {
		return 0, nil
	}
	drop := map[string]bool{}
	for _, k := range keys {
		drop[filepath.Clean(k)] = true
	}
	kept := make([]string, 0, len(list))
	n := 0
	for _, have := range list {
		if drop[filepath.Clean(have)] {
			n++
			continue
		}
		kept = append(kept, have)
	}
	if n == 0 {
		return 0, nil
	}
	lb, err := marshalRaw(kept)
	if err != nil {
		return 0, err
	}
	top["trustedWorkspaces"] = lb
	out, err := marshalRaw(top)
	if err != nil {
		return 0, err
	}
	if err := writeSettings(cfg, append(out, '\n'), mode); err != nil {
		return 0, err
	}
	return n, nil
}

// UntrustCodex removes the [projects."<path>"] table TrustCodex added to Codex's config.toml at cfg: exactly its two lines (trust_level = "trusted"), and only if the file still parses afterwards. A table with
// anything else in it, or a file that does not match, is left as it is. It reports whether it removed one.
func UntrustCodex(cfg, path string) (bool, error) {
	n, err := untrustCodexKeys(cfg, []string{path})
	return n > 0, err
}

// untrustCodexKeys removes the table of each of paths in one read and one write of the file, each removal checked in memory as UntrustCodex's is (a table that cannot be taken out cleanly stays; the first such
// error is returned after the others are done), and returns how many it removed. Nothing removed: no write.
func untrustCodexKeys(cfg string, paths []string) (int, error) {
	existing, mode, err := readConfig(cfg)
	if err != nil {
		if errors.Is(err, ErrNoConfig) {
			return 0, nil
		}
		return 0, err
	}
	text := existing
	n := 0
	var firstErr error
	for _, path := range paths {
		key, err := codexTableKey(path, runtime.GOOS == "windows")
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		block := []byte(fmt.Sprintf("[projects.%s]\ntrust_level = \"trusted\"\n", key))
		i := bytes.Index(text, block)
		if i < 0 || (i > 0 && text[i-1] != '\n') {
			continue
		}
		next := append([]byte(nil), text[:i]...)
		next = append(next, text[i+len(block):]...)
		next = bytes.TrimRight(next, "\n")
		if len(next) > 0 {
			next = append(next, '\n')
		}
		var check map[string]any
		if err := toml.Unmarshal(next, &check); err != nil && len(next) > 0 {
			if firstErr == nil {
				firstErr = errors.New("the table could not be removed without breaking Codex's settings file")
			}
			continue
		}
		text = next
		n++
	}
	if n == 0 {
		return 0, firstErr
	}
	if err := writeSettings(cfg, text, mode); err != nil {
		return 0, err
	}
	return n, firstErr
}

// SweepGoneRunFolders removes the trust entries of run worktrees whose folder no longer exists (#17396): git keeps a worktree that has unsaved work and Coral's cleanup then leaves its entry, and a folder removed by
// hand never had its entry removed. Only keys directly inside worktreesRoot (as given or resolved) named job-run-<something> whose folder is absent (not "cannot be read": any other error keeps the entry) are
// taken, from Claude's settings at claudeCfg and Codex's at codexCfg, each file read once and written once for all of them (and not at all when none is gone). With a worktrees root that does not exist nothing is taken. It returns how many it removed; an error in one file does not stop the other.
func SweepGoneRunFolders(claudeCfg, codexCfg, agyCfg, worktreesRoot string) (int, error) {
	if worktreesRoot == "" || !filepath.IsAbs(worktreesRoot) {
		return 0, nil
	}
	if fi, err := os.Stat(worktreesRoot); err != nil || !fi.IsDir() {
		return 0, nil // an unmounted volume or a removed folder makes every key look gone: nothing is taken unless the root itself is there
	}
	roots := []string{filepath.Clean(worktreesRoot)}
	if r, err := filepath.EvalSymlinks(worktreesRoot); err == nil && filepath.Clean(r) != roots[0] {
		roots = append(roots, filepath.Clean(r))
	}
	gone := func(key string) bool {
		if !filepath.IsAbs(key) || !coralnames.IsJobRunName(filepath.Base(key)) {
			return false
		}
		inside := false
		for _, r := range roots {
			inside = inside || filepath.Dir(filepath.Clean(key)) == r
		}
		if !inside {
			return false
		}
		_, err := os.Lstat(key)
		return errors.Is(err, os.ErrNotExist)
	}
	removed := 0
	var firstErr error
	if raw, _, err := readConfig(claudeCfg); err == nil {
		var top struct {
			Projects map[string]json.RawMessage `json:"projects"`
		}
		if json.Unmarshal(raw, &top) == nil {
			var keys []string
			for key := range top.Projects {
				if gone(key) {
					keys = append(keys, key)
				}
			}
			n, err := untrustClaudeKeys(claudeCfg, keys)
			removed += n
			firstErr = err
		}
	} else if !errors.Is(err, ErrNoConfig) {
		firstErr = err
	}
	if raw, _, err := readConfig(codexCfg); err == nil {
		var top struct {
			Projects map[string]any `toml:"projects"`
		}
		if toml.Unmarshal(raw, &top) == nil {
			var keys []string
			for key := range top.Projects {
				if gone(key) {
					keys = append(keys, key)
				}
			}
			n, err := untrustCodexKeys(codexCfg, keys)
			removed += n
			if firstErr == nil {
				firstErr = err
			}
		}
	} else if !errors.Is(err, ErrNoConfig) && firstErr == nil {
		firstErr = err
	}
	if raw, _, err := readConfig(agyCfg); err == nil {
		var top struct {
			Workspaces []string `json:"trustedWorkspaces"`
		}
		if json.Unmarshal(raw, &top) == nil {
			var keys []string
			for _, key := range top.Workspaces {
				if gone(key) {
					keys = append(keys, key)
				}
			}
			n, err := untrustAgyKeys(agyCfg, keys)
			removed += n
			if firstErr == nil {
				firstErr = err
			}
		}
	} else if !errors.Is(err, ErrNoConfig) && firstErr == nil {
		firstErr = err
	}
	return removed, firstErr
}
