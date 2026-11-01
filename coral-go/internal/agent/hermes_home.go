package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/safefs"
)

// A Hermes agent runs with a HERMES_HOME that Coral owns, one for each team (#11831, Security's ruling): Hermes searches its own state.db across sessions, so in one home an agent of team A could find team B's
// history, and Coral keeps teams apart elsewhere. The person's own ~/.hermes is only READ (its config.yaml and .env seed the team's home on first use) and never written. Coral's hook entries are the only hooks
// in the home's config.yaml (the person's hooks block, with any outbound hooks, is not carried: each would ask for consent, and none of them is Coral's), and the home's allowlist holds only Coral's own entries,
// so the agent never runs with HERMES_ACCEPT_HOOKS. The home's .env is created 0600 from the start (O_EXCL) and never written back.

const (
	hermesHomesFolder = "hermes-homes"
	hermesSeedMax     = 1 << 20 // a seed file's size cap (the installer's config.yaml is 129 KB, the .env 28 KB)
	hermesHookTimeout = 10
)

// hermesHookEvents are the Hermes hooks Coral installs, the same set coral-hook-agentic-state --hermes records (a test in that command pins the two together).
var hermesHookEvents = []string{"on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "on_session_end", "on_human_input_request", "on_human_input_resolved", "on_session_finalize"}

// HermesHookEvents is hermesHookEvents, for the test that keeps it equal to what the hook records.
func HermesHookEvents() []string { return append([]string(nil), hermesHookEvents...) }

// HermesTeamHome is the folder a team's Hermes agents share: <data dir>/hermes-homes/<16 hex digits of the team name's hash>. The name is only hashed, so no team name can name another folder.
func HermesTeamHome(dataDir, team string) string {
	sum := sha256.Sum256([]byte(team))
	return filepath.Join(dataDir, hermesHomesFolder, hex.EncodeToString(sum[:8]))
}

// privateDir makes dir (and its parents) 0700 if missing and refuses one that is a link or not a folder.
func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("hermes: %s is not a plain folder", filepath.Base(dir))
	}
	return nil
}

// hermesSeed reads one file of the person's Hermes home as a capped regular file, never a link: "" with nothing there.
func hermesSeed(personHome, name string) []byte {
	if personHome == "" {
		return nil
	}
	root, err := safefs.OpenRoot(personHome)
	if err != nil {
		return nil
	}
	defer root.Close()
	b, err := root.ReadFile(name, hermesSeedMax)
	if err != nil {
		return nil
	}
	return b
}

// writeHomeFile replaces name in home with data, mode 0600, through a private temp file and an atomic rename.
func writeHomeFile(home, name string, data []byte) error {
	f, err := os.CreateTemp(home, ".coral-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return fsreplace.Rename(f.Name(), filepath.Join(home, name))
}

// hermesHookCommand is the command line of one of Coral's entries: the hook tool by its absolute path, quoted (Hermes splits it as a shell would, without running a shell). "" when there is no tools folder or no
// such tool: the bare name would be found through PATH, where another program could stand in for it, so no hook is installed and the agent's state comes from the screen alone.
func hermesHookCommand(event string) string {
	cmd := ResolveHookCommand("coral-hook-agentic-state --hermes " + event)
	if !strings.HasPrefix(cmd, `"`) {
		return ""
	}
	return cmd
}

// PrepareHermesHome makes the team's home ready and returns it: the folder, a .env seeded from the person's (0600, created exclusively, kept at 0600, never rewritten), a config.yaml whose hooks block is Coral's own and
// nothing else of Hermes's settings is changed, and the allowlist of exactly those hooks. personHome is the person's own Hermes home, read only.
func PrepareHermesHome(dataDir, team, personHome string, now time.Time) (string, error) {
	if dataDir == "" {
		return "", errors.New("hermes: no Coral data folder")
	}
	if err := privateDir(filepath.Join(dataDir, hermesHomesFolder)); err != nil {
		return "", err
	}
	home := HermesTeamHome(dataDir, team)
	if err := privateDir(home); err != nil {
		return "", err
	}
	if err := seedHermesEnv(home, personHome); err != nil {
		return "", err
	}
	commands := map[string]string{}
	for _, ev := range hermesHookEvents {
		if c := hermesHookCommand(ev); c != "" {
			commands[ev] = c
		}
	}
	if err := writeHermesConfig(home, personHome, commands); err != nil {
		return "", err
	}
	if err := writeHermesAllowlist(home, commands, now); err != nil {
		return "", err
	}
	return home, nil
}

// seedHermesEnv creates the home's .env from the person's the first time, 0600 from the first byte; an existing one is kept, its mode brought to 0600 if it is looser, and a link there is refused.
func seedHermesEnv(home, personHome string) error {
	p := filepath.Join(home, ".env")
	if fi, err := os.Lstat(p); err == nil {
		if !fi.Mode().IsRegular() {
			return errors.New("hermes: the team's .env is not a regular file")
		}
		if fi.Mode().Perm()&0o077 != 0 {
			return os.Chmod(p, 0o600)
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(hermesSeed(personHome, ".env"))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// writeHermesConfig writes the home's config.yaml: the team's own if it has one, else the person's (a seed), with the top-level hooks block replaced by Coral's entries (none when there are none) and hooks_auto_accept
// removed. Every other setting is kept as it was, comments included.
func writeHermesConfig(home, personHome string, commands map[string]string) error {
	src, err := safefs.OpenRoot(home)
	if err != nil {
		return err
	}
	raw, rerr := src.ReadFile("config.yaml", hermesSeedMax)
	src.Close()
	if rerr != nil {
		raw = hermesSeed(personHome, "config.yaml")
	}
	var doc yaml.Node
	if len(strings.TrimSpace(string(raw))) > 0 {
		if err := yaml.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("hermes: config.yaml is not YAML Coral can read: %w", err)
		}
	}
	var top *yaml.Node
	if doc.Kind == yaml.DocumentNode && len(doc.Content) == 1 && doc.Content[0].Kind == yaml.MappingNode {
		top = doc.Content[0]
	} else if doc.Kind == 0 {
		top = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{top}}
	} else {
		return errors.New("hermes: config.yaml is not a mapping")
	}
	kept := top.Content[:0:0]
	for i := 0; i+1 < len(top.Content); i += 2 {
		if k := top.Content[i].Value; k == "hooks" || k == "hooks_auto_accept" {
			continue
		}
		kept = append(kept, top.Content[i], top.Content[i+1])
	}
	top.Content = kept
	if len(commands) > 0 {
		hooks := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		for _, ev := range hermesHookEvents {
			c, ok := commands[ev]
			if !ok {
				continue
			}
			entry := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{
				{Kind: yaml.ScalarNode, Tag: "!!str", Value: "command"}, {Kind: yaml.ScalarNode, Tag: "!!str", Value: c, Style: yaml.DoubleQuotedStyle},
				{Kind: yaml.ScalarNode, Tag: "!!str", Value: "timeout"}, {Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprint(hermesHookTimeout)},
			}}
			hooks.Content = append(hooks.Content,
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: ev},
				&yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: []*yaml.Node{entry}})
		}
		top.Content = append(top.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "hooks"}, hooks)
	}
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	return writeHomeFile(home, "config.yaml", out)
}

// hermesAllowlist is shell-hooks-allowlist.json as Hermes v0.22.5 writes it (#11715): an approvals array, an entry for each (event, command) pair with the script's mtime at approval.
type hermesAllowlist struct {
	Approvals []hermesApproval `json:"approvals"`
}

type hermesApproval struct {
	ApprovedAt            string `json:"approved_at"`
	Command               string `json:"command"`
	Event                 string `json:"event"`
	ScriptMtimeAtApproval string `json:"script_mtime_at_approval"`
}

const hermesTimeLayout = "2006-01-02T15:04:05.000000Z"

// writeHermesAllowlist replaces the home's allowlist with Coral's own entries, one for each hook it installed and no other: whatever was there is not carried. The script's mtime is the hook tool's real one (Hermes's
// hooks doctor reports drift from it).
func writeHermesAllowlist(home string, commands map[string]string, now time.Time) error {
	list := hermesAllowlist{Approvals: []hermesApproval{}}
	for _, ev := range hermesHookEvents {
		c, ok := commands[ev]
		if !ok {
			continue
		}
		tool := hookToolPath("coral-hook-agentic-state")
		fi, err := os.Stat(filepath.FromSlash(tool))
		if err != nil {
			return err
		}
		list.Approvals = append(list.Approvals, hermesApproval{
			ApprovedAt: now.UTC().Format(hermesTimeLayout), Command: c, Event: ev, ScriptMtimeAtApproval: fi.ModTime().UTC().Format(hermesTimeLayout),
		})
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	return writeHomeFile(home, "shell-hooks-allowlist.json", b)
}
