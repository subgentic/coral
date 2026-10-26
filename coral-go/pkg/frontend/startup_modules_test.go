package frontend

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func TestModuleGraphFollowsStaticImportsOnly(t *testing.T) {
	fsys := fstest.MapFS{
		"app.js":       {Data: []byte("import { a } from './a.js';\nimport './side.js';\nexport { c } from './sub/c.js';\n// import { x } from './commented.js';\n/* import './block.js'; */\nconst m = await importOnce('./lazy.js');\n")},
		"a.js":         {Data: []byte("import { b } from './b.js';\nexport const a = 1;\n")},
		"b.js":         {Data: []byte("export const b = 2;\n")},
		"side.js":      {Data: []byte("")},
		"sub/c.js":     {Data: []byte("import { b } from '../b.js';\nexport const c = 3;\n")},
		"lazy.js":      {Data: []byte("import { z } from './z.js';\n")},
		"z.js":         {Data: []byte("")},
		"commented.js": {Data: []byte("")},
		"block.js":     {Data: []byte("")},
	}
	got := moduleGraph(fsys, "app.js")
	want := []string{"a.js", "app.js", "b.js", "side.js", "sub/c.js"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("graph = %v, want %v (lazy, commented and block-commented modules must not be in it)", got, want)
	}
}

func TestModuleGraphSkipsMissingFilesAndCycles(t *testing.T) {
	fsys := fstest.MapFS{
		"app.js": {Data: []byte("import './a.js';\nimport './missing.js';\n")},
		"a.js":   {Data: []byte("import './app.js';\n")},
	}
	got := moduleGraph(fsys, "app.js")
	if strings.Join(got, ",") != "a.js,app.js" {
		t.Fatalf("graph = %v, want [a.js app.js]", got)
	}
}

// Moving entry responsibilities into modules must retain the original dependencies;
// static re-exports count too, while panels loaded on demand stay outside the list.
func TestModuleGraphFollowsSplitEntry(t *testing.T) {
	before := fstest.MapFS{
		"app.js":   {Data: []byte("import './state.js';\nimport './nav.js';\n")},
		"state.js": {Data: []byte("")},
		"nav.js":   {Data: []byte("")},
	}
	after := fstest.MapFS{
		"app.js":          {Data: []byte("import './initial_load.js';\nexport { startRoute } from './app_routes.js';\n")},
		"initial_load.js": {Data: []byte("import './state.js';\n")},
		"app_routes.js":   {Data: []byte("import './nav.js';\nimport './state.js';\nconst panel = () => importOnce('./panel.js');\n")},
		"state.js":        before["state.js"],
		"nav.js":          before["nav.js"],
		"panel.js":        {Data: []byte("")},
	}
	got := moduleGraph(after, "app.js")
	want := []string{"app.js", "app_routes.js", "initial_load.js", "nav.js", "state.js"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("split startup graph = %v, want %v", got, want)
	}
	for _, module := range moduleGraph(before, "app.js") {
		if !strings.Contains(","+strings.Join(got, ",")+",", ","+module+",") {
			t.Errorf("split lost startup module %s", module)
		}
	}
}

// The real startup graph: large, every file exists, and the lazily loaded dialogs and panels are not in it.
func TestStartupModulesIsTheRealGraph(t *testing.T) {
	mods := StartupModules()
	if len(mods) < 100 {
		t.Fatalf("startup graph has %d modules, expected well over 100", len(mods))
	}
	in := map[string]bool{}
	sub, _ := fs.Sub(Static, "static")
	for _, m := range mods {
		in[m] = true
		if _, err := fs.Stat(sub, m); err != nil {
			t.Errorf("startup module %s does not exist: %v", m, err)
		}
		if strings.Contains(m, "..") || strings.HasPrefix(m, "/") {
			t.Errorf("startup module path %q escapes the static root", m)
		}
	}
	for _, must := range []string{"app.js", "render.js", "state.js", "live_chat.js", "tasks.js"} {
		if !in[must] {
			t.Errorf("startup graph lacks %s", must)
		}
	}
	for _, lazy := range []string{"modals.js", "workflows.js", "docs.js", "cost_dashboard.js", "chat_search.js", "theme_config.js", "cloud_connect.js", "inbox_panel.js", "inbox_coral.js"} {
		if in[lazy] {
			t.Errorf("%s is loaded lazily, it must not be in the startup graph", lazy)
		}
	}
}

// The shell renders one modulepreload hint per module the embedder puts in PageData.ModulePreloads, under its static base, and none by default
// (the standalone Coral server leaves them off: on localhost they delay the first paint and do not make the app ready sooner, #3900).
func TestShellRendersModulepreloadHintsFromPageData(t *testing.T) {
	tmpl, err := ParseIndex()
	if err != nil {
		t.Fatal(err)
	}
	render := func(d PageData) string {
		var b strings.Builder
		if err := tmpl.Execute(&b, d); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	if strings.Contains(render(PageData{StaticBase: "/static/b/x/"}), `rel="modulepreload"`) {
		t.Error("a shell with no ModulePreloads must carry no modulepreload hints")
	}
	mods := StartupModules()
	body := render(PageData{StaticBase: "/static/v/abc/", ModulePreloads: mods})
	if n := strings.Count(body, `<link rel="modulepreload" href="/static/v/abc/`); n != len(mods) {
		t.Errorf("%d hints rendered for %d modules", n, len(mods))
	}
	for _, want := range []string{`href="/static/v/abc/app.js"`, `href="/static/v/abc/render.js"`} {
		if !strings.Contains(body, want) {
			t.Errorf("shell lacks the hint %s", want)
		}
	}
	if strings.Contains(body, `href="/static/v/abc/modals.js"`) {
		t.Error("a lazily loaded module must not be hinted")
	}
	// hints come after the stylesheets, so the render-blocking CSS is asked for first
	if strings.Index(body, `rel="modulepreload"`) < strings.LastIndex(body, `rel="stylesheet"`) {
		t.Error("the modulepreload hints must come after the stylesheet links")
	}
}

// The release's static tree is minified (every file on one line, local names shortened): its startup graph, which feeds the shell's modulepreload links, is the source tree's. A scan that only sees the first
// import of a line found 2 modules of 263 (#7185, QA's finding on #7366).
func TestStartupGraphOfAMinifiedTreeIsTheSourcesGraph(t *testing.T) {
	sub, err := fs.Sub(Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	min := fstest.MapFS{}
	_ = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, _ := fs.ReadFile(sub, p)
		if strings.HasSuffix(p, ".js") && !strings.HasPrefix(p, "vendor/") {
			data = MinifyAsset(p, data)
		}
		min[p] = &fstest.MapFile{Data: data}
		return nil
	})
	want, got := moduleGraph(sub, "app.js"), moduleGraph(min, "app.js")
	if len(want) < 100 {
		t.Fatalf("the source tree's startup graph has only %d modules: the scan is not reading it", len(want))
	}
	have := map[string]bool{}
	for _, m := range got {
		have[m] = true
	}
	var missing []string
	for _, m := range want {
		if !have[m] {
			missing = append(missing, m)
		}
	}
	if len(missing) > 0 {
		t.Errorf("the minified tree's startup graph has %d modules, the source's %d; missing %d, e.g. %v", len(got), len(want), len(missing), missing[:min2(len(missing), 5)])
	}
}

func min2(a, b int) int {
	if a < b {
		return a
	}
	return b
}
