package frontend

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
)

// Inbox modules retain their ordered await importOnce evaluation. Fetch their
// unconditional module-scope dependencies together instead of discovering each
// URL only after the preceding module has evaluated. Hints never evaluate code;
// importOnce still owns execution, sharing and retries. Function-local imports
// (other pages and dialogs) are deliberately excluded.
var inboxModuleAwait = regexp.MustCompile(`(?m)^(?:(?:export )?(?:const|let) [^=\n]+ = |)await importOnce[^\n]*`)
var inboxImportTarget = regexp.MustCompile(`await importOnce\(['"]\./([^'"]+)['"]`)

func inboxPreloads(static fs.FS, startup map[string]bool) []string {
	seen := map[string]bool{"inbox_sidebar.js": true}
	groups := map[string]string{}
	for _, g := range LazyGroups {
		for _, m := range g.Members {
			groups[m] = g.Main
		}
	}
	hints := map[string]bool{}
	var visit func(string)
	visit = func(name string) {
		data, err := fs.ReadFile(static, name)
		if err != nil {
			return
		}
		for _, line := range inboxModuleAwait.FindAllString(string(data), -1) {
			for _, target := range inboxImportTarget.FindAllStringSubmatch(line, -1) {
				dep := target[1]
				if startup[dep] || seen[dep] {
					continue
				}
				seen[dep] = true
				hint := dep
				if main := groups[dep]; main != "" {
					hint = main
				}
				hints[hint] = true
				visit(dep)
			}
		}
	}
	visit("inbox_sidebar.js")
	result := make([]string, 0, len(hints))
	for name := range hints {
		result = append(result, "./"+name)
	}
	sort.Strings(result)
	return result
}

func inboxPreloadPrelude(names []string) []byte {
	if len(names) == 0 {
		return nil
	}
	data, _ := json.Marshal(names)
	return []byte(`for(const p of ` + string(data) + `){const l=document.createElement('link');l.rel='modulepreload';l.href=new URL(p,import.meta.url);document.head.append(l);}` + "\n")
}

// Keep this helper's output out of app.js: only opening the lazy Inbox starts
// these fetches, and every URL keeps the build-versioned bundle prefix.
func withInboxPreloads(name string, js []byte, hints []string) []byte {
	if strings.TrimSuffix(name, ".js") != "inbox_sidebar" {
		return js
	}
	return append(inboxPreloadPrelude(hints), js...)
}

func inboxPreloadSourceMap(name string, data []byte, hints []string) ([]byte, error) {
	if name != "inbox_sidebar.js" || len(hints) == 0 || len(data) == 0 {
		return data, nil
	}
	var source map[string]json.RawMessage
	if err := json.Unmarshal(data, &source); err != nil {
		return nil, err
	}
	var mappings string
	if err := json.Unmarshal(source["mappings"], &mappings); err != nil {
		return nil, fmt.Errorf("inbox preload mappings: %w", err)
	}
	source["mappings"], _ = json.Marshal(";" + mappings)
	return json.Marshal(source)
}
