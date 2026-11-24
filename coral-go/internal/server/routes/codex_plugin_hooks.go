package routes

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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

// codexPluginHooks says, for the enabled Codex plugins that ship hooks/codex-hooks.json, which ones Codex would ask about: Changed are plugins with a hook whose trusted_hash in config.toml
// ([hooks.state."<plugin>@<market>:hooks/codex-hooks.json:<event>:<group>:<handler>"]) is missing or differs from the hash of the file's current hook (the same normalized identity as
// internal/agent codexHookTrustHash: event name snake_case, the matcher, the handler with timeout default 600 and async false); Unsure are plugins with a hook shape this cannot hash exactly
// (a key it does not know). Names only: no hook content is kept or shown, never the auth file. #21226.
type codexPluginHooks struct{ Changed, Unsure []string }

var codexStateTable = regexp.MustCompile(`^\[hooks\.state\."([^"]+)"\]\s*$`)
var codexTrustedHash = regexp.MustCompile(`^trusted_hash\s*=\s*"(sha256:[0-9a-f]{64})"\s*$`)
var codexCamelWord = regexp.MustCompile(`([a-z0-9])([A-Z])`)

func codexSnake(event string) string {
	return strings.ToLower(codexCamelWord.ReplaceAllString(event, "${1}_${2}"))
}

// codexHookIdentityHash is the hash Codex keeps for a hook: sha256 of the compact, key-sorted JSON of its identity; ok is false when the hook has a key this does not know.
func codexHookIdentityHash(event string, group, handler map[string]any) (string, bool) {
	for k := range group {
		if k != "matcher" && k != "hooks" {
			return "", false
		}
	}
	h := map[string]any{"type": "command", "async": false, "timeout": float64(600)}
	for k, v := range handler {
		switch k {
		case "type", "command":
			h[k] = v
		case "timeout":
			h[k] = v
		case "async":
			h[k] = v
		default:
			return "", false
		}
	}
	if h["type"] != "command" {
		return "", false
	}
	id := map[string]any{"event_name": codexSnake(event), "hooks": []any{h}}
	if m, ok := group["matcher"]; ok {
		id["matcher"] = m
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if enc.Encode(id) != nil {
		return "", false
	}
	sum := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	return "sha256:" + hex.EncodeToString(sum[:]), true
}

// codexVersionLess orders version folder names by their dot-separated numbers (1.9 before 1.10); a part that is no number sorts by its text.
func codexVersionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		na, ea := strconv.Atoi(pa[i])
		nb, eb := strconv.Atoi(pb[i])
		if ea == nil && eb == nil && na != nb {
			return na < nb
		}
		if (ea != nil || eb != nil) && pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return len(pa) < len(pb)
}

func codexPluginHookReview(home string) codexPluginHooks {
	cfgPath := foldertrust.CodexConfigPath(home)
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		return codexPluginHooks{}
	}
	codexHome := filepath.Dir(cfgPath)
	type plug struct{ name, market string }
	var plugins []plug
	trusted := map[string]string{} // state key -> trusted_hash
	var cur string
	name, market, enabled := "", "", false
	flush := func() {
		if name != "" && enabled {
			plugins = append(plugins, plug{name, market})
		}
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			flush()
			name, market, enabled, cur = "", "", false, ""
			if m := codexPluginTable.FindStringSubmatch(line); m != nil {
				name, market = m[1], m[2]
			} else if m := codexStateTable.FindStringSubmatch(line); m != nil {
				cur = m[1]
			}
			continue
		}
		if name != "" && strings.ReplaceAll(line, " ", "") == "enabled=true" {
			enabled = true
		}
		if cur != "" {
			if m := codexTrustedHash.FindStringSubmatch(line); m != nil {
				trusted[cur] = m[1]
			}
		}
	}
	flush()
	var out codexPluginHooks
	for _, p := range plugins {
		files, _ := filepath.Glob(filepath.Join(codexHome, "plugins", "cache", p.market, p.name, "*", "hooks", "codex-hooks.json"))
		if len(files) == 0 {
			continue
		}
		sort.Slice(files, func(i, j int) bool {
			return codexVersionLess(filepath.Base(filepath.Dir(filepath.Dir(files[i]))), filepath.Base(filepath.Dir(filepath.Dir(files[j]))))
		})
		raw, err := os.ReadFile(files[len(files)-1]) // the newest version folder, by number (1.10 is after 1.9)
		var doc struct {
			Hooks map[string][]map[string]any `json:"hooks"`
		}
		if err != nil || json.Unmarshal(raw, &doc) != nil {
			out.Unsure = append(out.Unsure, p.name)
			continue
		}
		changed, unsure := false, false
		for event, groups := range doc.Hooks {
			for gi, g := range groups {
				handlers, _ := g["hooks"].([]any)
				for hi, hv := range handlers {
					hm, _ := hv.(map[string]any)
					want, ok := codexHookIdentityHash(event, g, hm)
					if !ok {
						unsure = true
						continue
					}
					key := fmt.Sprintf("%s@%s:hooks/codex-hooks.json:%s:%d:%d", p.name, p.market, codexSnake(event), gi, hi)
					if trusted[key] != want {
						changed = true
					}
				}
			}
		}
		switch {
		case changed:
			out.Changed = append(out.Changed, p.name)
		case unsure:
			out.Unsure = append(out.Unsure, p.name)
		}
	}
	sort.Strings(out.Changed)
	sort.Strings(out.Unsure)
	return out
}

// codexHookReviewNote is the card's plain sentence for Codex's hook review: whose hooks it is not, and where it comes from: exact when a plugin's hash differs from the one trusted, "most likely" when the hooks cannot be hashed.
func codexHookReviewNote(r codexPluginHooks) string {
	const lead = "These are not Coral's hooks: Coral already trusts its own. "
	const unchecked = "Hooks from the folder or your own Codex settings are not checked here and may be in this review too. "
	const risk = "Trust all lets them run outside the sandbox; Continue without trusting skips them."
	join := func(l []string) (string, string) {
		word := "plugin"
		list := l[0]
		if len(l) > 1 {
			word, list = "plugins", strings.Join(l[:len(l)-1], ", ")+" or "+l[len(l)-1]
		}
		return word, list
	}
	if len(r.Changed) > 0 {
		word, list := join(r.Changed)
		verb := "changed its hook"
		if len(r.Changed) > 1 {
			verb = "changed their hooks"
		}
		return lead + "The Codex " + word + " " + list + " " + verb + " (new or updated since you last trusted it). " + unchecked + risk
	}
	if len(r.Unsure) > 0 {
		word, list := join(r.Unsure)
		return lead + "Most likely the Codex " + word + " " + list + " (a plugin update changes its hook). " + unchecked + risk
	}
	return lead + "A Codex plugin, the folder or your own Codex settings added or changed one. " + risk
}
