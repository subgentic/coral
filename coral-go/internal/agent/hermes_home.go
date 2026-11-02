package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/subgentic/coral/internal/diskguard"
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

// HermesTeamHome is the folder a team's Hermes homes are made in: <data dir>/hermes-homes/<16 hex digits of the team name's hash>. The name is only hashed, so no team name can name another folder.
func HermesTeamHome(dataDir, team string) string {
	sum := sha256.Sum256([]byte(team))
	return filepath.Join(dataDir, hermesHomesFolder, hex.EncodeToString(sum[:8]))
}

// HermesAgentHome is the HERMES_HOME of one agent: <team folder>/<its Coral session id>. Hermes runs ONE gateway process for a home and runs every hook from it with the environment of the agent that started it, so
// agents that shared a home had their events, Stop and chat taken for the first agent's (the tester's run on v2.0.29, #11936). A home of its own puts each agent's identity where no other agent can stand in for it. The
// id is a canonical Coral session id (hex digits and dashes only), so it is one path element and names no other folder: "" for anything else.
func HermesAgentHome(dataDir, team, sessionID string) string {
	if !canonicalSessionID.MatchString(sessionID) {
		return ""
	}
	return filepath.Join(HermesTeamHome(dataDir, team), sessionID)
}

// hermesMinFree is the free space a new home needs: Hermes prepares its runtime in it on first use, about 400 MB (the tester's run), and the agent's sessions grow it. A launch under this refuses with a clear message
// and makes nothing (the team's other agents are not touched).
const hermesMinFree = 2 << 30

// RemoveHermesHome removes an agent's home when the agent is deleted (a restart or a wake keeps it, so the agent's conversation can be resumed). A home that is not there, or an id that is not one, is nothing to do;
// a link in its place is removed as a link and never followed.
func RemoveHermesHome(dataDir, team, sessionID string) error {
	home := HermesAgentHome(dataDir, team, sessionID)
	if home == "" {
		return nil
	}
	for _, dir := range []string{filepath.Join(dataDir, hermesHomesFolder), HermesTeamHome(dataDir, team)} { // os.RemoveAll follows a link in a parent: each is checked first, as on the way in
		if fi, err := os.Lstat(dir); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("hermes: %s is a link: the agent's home was not removed", filepath.Base(dir))
		}
	}
	if _, err := os.Lstat(home); err != nil {
		return nil
	}
	return os.RemoveAll(home)
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
	if fi.Mode().Perm()&0o077 != 0 { // made looser by an earlier version or by hand: the agent can write in it
		return os.Chmod(dir, 0o700)
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
	if err := hermesToolTrusted(filepath.FromSlash(hookToolPath("coral-hook-agentic-state"))); err != nil {
		slog.Info("hermes: Coral's hook is not installed for this launch", "why", err)
		return ""
	}
	return cmd
}

// PrepareHermesHome makes the agent's home ready and returns it: the folder, a .env seeded from the person's (0600, created exclusively, kept at 0600, never rewritten), a config.yaml whose hooks block is Coral's own and
// nothing else of Hermes's settings is changed, and the allowlist of exactly those hooks. personHome is the person's own Hermes home, read only. A home that does not exist yet is made only when the volume has
// hermesMinFree free.
func PrepareHermesHome(dataDir, team, sessionID, personHome string, now time.Time) (string, error) {
	return prepareHermesHome(dataDir, team, sessionID, personHome, now, diskguard.FreeBytes)
}

func prepareHermesHome(dataDir, team, sessionID, personHome string, now time.Time, free func(dir string) (uint64, error)) (string, error) {
	if dataDir == "" {
		return "", errors.New("hermes: no Coral data folder")
	}
	home := HermesAgentHome(dataDir, team, sessionID)
	if home == "" {
		return "", errors.New("hermes: the agent has no session id to name its home by")
	}
	if err := privateDir(filepath.Join(dataDir, hermesHomesFolder)); err != nil {
		return "", err
	}
	if err := privateDir(HermesTeamHome(dataDir, team)); err != nil { // each level on its own: a link in any of them is refused, not followed
		return "", err
	}
	if _, err := os.Lstat(home); err != nil {
		if f, ferr := free(filepath.Dir(home)); ferr == nil && f < hermesMinFree {
			return "", fmt.Errorf("hermes: not enough free disk to make this agent's home: it needs about 2 GB and %.1f GB is free", float64(f)/(1<<30))
		}
	}
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

// A seeded config carries the person's own Hermes settings into the team home as they are, their approval settings included (a person who turned approvals off in their own Hermes has them off here): only the hooks
// block, hooks_auto_accept and the telemetry answer are Coral's (#11831, Security's INFO).
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
	seedTelemetryAnswer(top)
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

// seedTelemetryAnswer answers Hermes's first-run telemetry question "No thanks" in the config itself: a home whose telemetry.shared_metrics has offer_version 2 never shows the question (the tester's re-run,
// #11715), so nothing has to press Enter. A person who already answered the current offer in their own config keeps their answer; an unanswered one gets enabled and send false, and the settings next to them stay.
func seedTelemetryAnswer(top *yaml.Node) {
	mapping := func(parent *yaml.Node, key string) *yaml.Node {
		for i := 0; i+1 < len(parent.Content); i += 2 {
			if parent.Content[i].Value == key {
				if parent.Content[i+1].Kind != yaml.MappingNode {
					parent.Content[i+1] = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
				}
				return parent.Content[i+1]
			}
		}
		m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, m)
		return m
	}
	sm := mapping(mapping(top, "telemetry"), "shared_metrics")
	for i := 0; i+1 < len(sm.Content); i += 2 {
		if sm.Content[i].Value == "offer_version" {
			if n, err := strconv.Atoi(sm.Content[i+1].Value); err == nil && n >= hermesTelemetryOffer {
				return // already answered this offer: their answer stands
			}
		}
	}
	set := func(key, tag, value string) {
		for i := 0; i+1 < len(sm.Content); i += 2 {
			if sm.Content[i].Value == key {
				sm.Content[i+1] = &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value}
				return
			}
		}
		sm.Content = append(sm.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value})
	}
	set("offer_version", "!!int", strconv.Itoa(hermesTelemetryOffer))
	set("enabled", "!!bool", "false")
	set("send", "!!bool", "false")
}

// hermesTelemetryOffer is the telemetry offer's version in Hermes v0.22.5.
const hermesTelemetryOffer = 2

// A Hermes agent is told what other agents get on the command line (the board protocol and its role, the launch prompt, Coral's session marker) by being TYPED it as its first message once Hermes is ready:
// an argument shows in ps and in the shell's history (Security, #11831). LaunchCommand writes the text to <agent home>/first-messages/<Coral session id>.txt (0600, in a 0700 folder), and the server types it and
// removes the file (internal/server/routes, deliverHermesFirstMessage).

// HermesFirstMessagePath is the file of a session's first message, "" for an id that is not a canonical Coral session id.
func HermesFirstMessagePath(dataDir, team, sessionID string) string {
	home := HermesAgentHome(dataDir, team, sessionID)
	if home == "" {
		return ""
	}
	return filepath.Join(home, "first-messages", sessionID+".txt")
}

var canonicalSessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// hermesFirstMessage is what the agent is told: the board system prompt (with the protocol file), then the action prompt (the launch prompt and the board's action text), then the session marker.
func hermesFirstMessage(params LaunchParams) string {
	var sys []string
	if proto := readProtocolFile(params.ProtocolPath); proto != "" {
		sys = append(sys, proto)
	}
	if b := BuildBoardSystemPrompt(params.BoardName, params.Role, "", params.PromptOverrides, params.BoardType); b != "" {
		sys = append(sys, b)
	}
	action := BuildBoardActionPrompt(params.boardPromptName(), params.Role, params.Prompt, params.PromptOverrides, params.BoardType)
	if action == "" {
		action = params.Prompt
	}
	if len(sys) == 0 && action == "" {
		return "" // nothing to tell
	}
	sys = appendCoralSessionMarker(sys, params.SessionID)
	parts := append(sys, action)
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// writeHermesFirstMessage writes the first message for a launch ("" text: nothing to write, and a file left by an earlier launch of the session is removed).
func writeHermesFirstMessage(dataDir string, params LaunchParams) error {
	path := HermesFirstMessagePath(dataDir, params.BoardName, params.SessionID)
	if path == "" {
		return nil
	}
	text := hermesFirstMessage(params)
	if text == "" {
		_ = os.Remove(path)
		return nil
	}
	dir := filepath.Dir(path)
	if err := privateDir(dir); err != nil {
		return err
	}
	return writeHomeFile(dir, filepath.Base(path), []byte(text))
}

// SweepHermesHomes removes the homes no session reaches (#11949): every folder in a team's folder under hermes-homes whose name is not a session id isLive says is
// live or sleeping, and whose own time is older than minAge. A home is made before its session's record is written, so a younger one may belong to a launch in progress. Each home holds a copy of the person's .env,
// so one that nothing reaches (a launch that failed after the home was made, a crash, a record deleted by hand) is not kept. A link is never followed or removed: not at hermes-homes, at a team's folder, or in place of a home. A failure to
// remove one entry is logged and does not stop the rest. It returns how many entries it removed.
func SweepHermesHomes(dataDir string, isLive func(sessionID string) bool, minAge time.Duration, now time.Time) int {
	if dataDir == "" {
		return 0
	}
	root := filepath.Join(dataDir, hermesHomesFolder)
	removed := 0
	for _, team := range plainFolders(root) {
		for _, home := range plainFolders(team) {
			name := filepath.Base(home)
			fi, err := os.Lstat(home)
			if err != nil || !fi.IsDir() { // gone since it was listed, or put back as a link
				continue
			}
			if isLive(name) || now.Sub(fi.ModTime()) < minAge {
				continue
			}
			if rerr := os.RemoveAll(home); rerr != nil {
				slog.Warn("hermes: an unused home was not removed", "home", name, "error", rerr)
				continue
			}
			removed++
		}
	}
	if removed > 0 {
		slog.Info("hermes: removed homes no session reaches", "count", removed)
	}
	return removed
}

// plainFolders are the folders directly under dir that are plain folders (not links), full paths; none when dir is not a plain folder itself.
func plainFolders(dir string) []string {
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsDir() { // DirEntry's type is the entry's own: a link is not a folder here
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out
}
