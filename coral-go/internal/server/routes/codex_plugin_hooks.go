package routes

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/foldertrust"
)

// Codex's hook review ("Hooks need review", "1 hook is new or changed.") names no hook. Coral trusts only its own six (codex_trust_hooks), so the one it asks about is a plugin's, a
// repository's or the person's own (#21208: the Operator's PostHog plugin, updated, asked again on every launch). The Needs you card says so, and names the Codex plugins that ship a hook
// file, read from the person's Codex config (names only: never a hook's content, never the auth file). #21209.

var codexPluginTable = regexp.MustCompile(`^\[plugins\."([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)"\]\s*$`)

// codexHookReview says whether the screen is Codex's hook review.
func codexHookReview(s promptScreen) bool {
	t := strings.ToLower(strings.TrimSpace(s.Title))
	return strings.HasPrefix(t, "hooks need review") || strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.Question)), "hooks need review")
}

// codexPluginHookNames lists the enabled Codex plugins (config.toml [plugins."name@market"] enabled = true) whose cached copy has hooks/codex-hooks.json, sorted; none when the config cannot be read.
func codexPluginHookNames(home string) []string {
	b, err := os.ReadFile(foldertrust.CodexConfigPath(home))
	if err != nil {
		return nil
	}
	codexHome := filepath.Dir(foldertrust.CodexConfigPath(home))
	var names []string
	name, market, enabled := "", "", false
	flush := func() {
		if name == "" || !enabled {
			return
		}
		if m, _ := filepath.Glob(filepath.Join(codexHome, "plugins", "cache", market, name, "*", "hooks", "codex-hooks.json")); len(m) > 0 {
			names = append(names, name)
		}
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			flush()
			name, market, enabled = "", "", false
			if m := codexPluginTable.FindStringSubmatch(line); m != nil {
				name, market = m[1], m[2]
			}
			continue
		}
		if name != "" && strings.ReplaceAll(line, " ", "") == "enabled=true" {
			enabled = true
		}
	}
	flush()
	sort.Strings(names)
	return names
}

// codexHookReviewNote is the card's plain sentence for Codex's hook review: whose hook it is not, and where it likely comes from.
func codexHookReviewNote(plugins []string) string {
	const lead = "These are not Coral's hooks: Coral already trusts its own. "
	const risk = "Trust all lets them run outside the sandbox; Continue without trusting skips them."
	if len(plugins) == 0 {
		return lead + "A Codex plugin, the folder or your own Codex settings added or changed one. " + risk
	}
	list := plugins[0]
	if len(plugins) > 1 {
		list = strings.Join(plugins[:len(plugins)-1], ", ") + " or " + plugins[len(plugins)-1]
	}
	word := "plugin"
	if len(plugins) > 1 {
		word = "plugins"
	}
	return lead + "Most likely the Codex " + word + " " + list + " (a plugin update changes its hook). " + risk
}
