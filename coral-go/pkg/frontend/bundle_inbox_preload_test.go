package frontend

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestInboxPreloadsOnlyEagerDependencies(t *testing.T) {
	tree := fstest.MapFS{
		"inbox_sidebar.js": {Data: []byte("const first = await importOnce('./first.js');\nconst later = await importOnce('./second.js');\nconst openPage = async () => await importOnce('./page.js');\n")},
		"first.js":         {Data: []byte("const x = await importOnce('./shared.js');\nconst y = await importOnce('./startup.js');\n")},
		"second.js":        {Data: []byte("const x = await importOnce('./shared.js');\nconst cycle = await importOnce('./inbox_sidebar.js');\n")},
		"shared.js":        {Data: []byte("export const ready = true;")},
	}
	got := strings.Join(inboxPreloads(tree, map[string]bool{"startup.js": true}), ",")
	if got != "./first.js,./second.js,./shared.js" {
		t.Fatalf("eager closure: %s", got)
	}
	js := string(inboxPreloadPrelude(inboxPreloads(tree, nil)))
	if !strings.Contains(js, "modulepreload") || !strings.Contains(js, "import.meta.url") || strings.Contains(js, "import(") {
		t.Fatalf("hints must fetch without evaluation: %s", js)
	}
	if string(withInboxPreloads("other.js", []byte("unchanged"), []string{"./first.js"})) != "unchanged" {
		t.Fatal("other pages must be untouched")
	}
}

func TestInboxPreloadMapOffset(t *testing.T) {
	got, err := inboxPreloadSourceMap("inbox_sidebar.js", []byte(`{"version":3,"mappings":"AAAA","sources":["inbox_sidebar.js"]}`), []string{"./first.js"})
	if err != nil || !strings.Contains(string(got), `"mappings":";AAAA"`) {
		t.Fatalf("banner mapping: %s %v", got, err)
	}
}
