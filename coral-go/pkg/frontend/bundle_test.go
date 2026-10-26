package frontend

import (
	"bytes"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/evanw/esbuild/pkg/api"
	"github.com/subgentic/coral/internal/safego"
)

var (
	bundleOnce sync.Once
	bundleVal  *Bundle
	bundleErr  error
)

func realBundle(t *testing.T) (*Bundle, fs.FS) {
	t.Helper()
	sub, err := fs.Sub(Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	index, err := fs.ReadFile(Templates, "templates/index.html")
	if err != nil {
		t.Fatal(err)
	}
	bundleOnce.Do(func() { bundleVal, bundleErr = BuildBundle(sub, index) })
	if bundleErr != nil {
		t.Fatalf("BuildBundle: %v", bundleErr)
	}
	return bundleVal, sub
}

// The startup graph is inside app.js, and every module in it has a stub at its own URL.
func TestBundleHasEveryStartupModuleOnceAndAStubForEach(t *testing.T) {
	b, static := realBundle(t)
	app := string(b.Files["app.js"])
	if len(b.Modules) < 100 {
		t.Fatalf("only %d modules in the bundle; the startup graph has about 130", len(b.Modules))
	}
	if !bytes.Contains(b.Files["app.js"], []byte("sourceMappingURL=app.js.map")) || len(b.Files["app.js.map"]) == 0 {
		t.Error("app.js has no source map, so an error would name app.js only")
	}
	// Inside the bundle nothing is imported by a relative URL any more: that would be a second copy of the module.
	if m := regexp.MustCompile(`(?m)\bfrom\s*["']\.{1,2}/`).FindString(app); m != "" {
		t.Errorf("app.js still imports a module by URL: %q", m)
	}
	for _, m := range b.Modules {
		if m == "app.js" {
			continue
		}
		stub, ok := b.Files[m]
		if !ok {
			t.Errorf("no stub for startup module %s", m)
			continue
		}
		if len(stub) > 4096 {
			t.Errorf("stub for %s is %d bytes: it should only re-export", m, len(stub))
		}
		want, err := exportNames(static, m)
		if err != nil {
			t.Fatal(err)
		}
		got := stubNames(string(stub))
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("stub for %s exports %v, the module exports %v", m, got, want)
		}
	}
}

var stubExport = regexp.MustCompile(`\b[\w$]+\$[\w$]+ as ([\w$]+)`)

func stubNames(stub string) []string {
	var out []string
	for _, m := range stubExport.FindAllStringSubmatch(stub, -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

// A stub's names are live bindings of the bundle's own instance: the bundle exports each alias, and the stub imports it from app.js
// by the right relative path (a module in a subdirectory climbs out of it).
func TestBundleStubsReExportFromAppJsByRelativePath(t *testing.T) {
	b, _ := realBundle(t)
	lazy := map[string]bool{}
	for _, m := range b.Lazy {
		lazy[m] = true // built against app.js directly, not stubs (TestLazy...)
	}
	for m, stub := range b.Files {
		if m == "app.js" || !strings.HasSuffix(m, ".js") || lazy[m] {
			continue
		}
		want := fmt.Sprintf("from '%s'", relativeTo(m, "app.js"))
		if !bytes.Contains(stub, []byte(want)) && string(stub) != "export {};\n" {
			t.Errorf("stub %s: want %s, got %q", m, want, stub)
		}
	}
	if got := relativeTo("cloud/x.js", "app.js"); got != "../app.js" {
		t.Errorf("relativeTo cloud/x.js = %s", got)
	}
	if got := relativeTo("state.js", "app.js"); got != "./app.js" {
		t.Errorf("relativeTo state.js = %s", got)
	}
}

// Every module that is not in the bundle (loaded later by importOnce) must still resolve every name it imports from a startup
// module through that module's stub. esbuild is the check: it refuses an import of a name the file does not export.
func TestEveryLazyModuleBuildsAgainstTheStubs(t *testing.T) {
	b, static := realBundle(t)
	inBundle := map[string]bool{}
	for _, m := range b.Modules {
		inBundle[m] = true
	}
	var lazy []string
	_ = fs.WalkDir(static, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".min.js") ||
			strings.HasPrefix(name, "vendor/") || strings.HasPrefix(name, "agent_docs/") || inBundle[name] {
			return nil
		}
		lazy = append(lazy, name)
		return nil
	})
	if len(lazy) < 20 {
		t.Fatalf("only %d lazy modules found", len(lazy))
	}
	var entry strings.Builder
	for i, m := range lazy {
		fmt.Fprintf(&entry, "import * as l%d from './%s';\nglobalThis.l%d = l%d;\n", i, m, i, i)
	}
	// Resolve through the bundled prefix's files, with the stubs standing where the startup modules were. A few lazy modules are
	// scripts (not modules) or need globals; esbuild reports only import/export problems, which is what is checked.
	res := bundleBuild(&overlayFS{files: b.Files, base: static}, entry.String(), "probe.js", false, nil)
	for _, e := range res.Errors {
		loc := ""
		if e.Location != nil {
			loc = fmt.Sprintf(" (%s:%d)", e.Location.File, e.Location.Line)
		}
		t.Errorf("lazy modules against the stubs: %s%s", e.Text, loc)
	}
}

// The shell's 24 stylesheets become one, in the shell's order, with the same bytes each.
func TestBundleStylesheetIsTheShellsStylesheetsInOrder(t *testing.T) {
	b, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	links := StylesheetsInShell(index)
	if len(links) < 20 {
		t.Fatalf("found %d stylesheet links in the shell; it has 24", len(links))
	}
	var want bytes.Buffer
	for _, l := range links {
		data, err := fs.ReadFile(static, l)
		if err != nil {
			t.Fatal(err)
		}
		want.Write(MinifyAsset(l, data))
		want.WriteByte('\n')
	}
	if !bytes.Equal(b.Files[BundleStylesheet], want.Bytes()) {
		t.Error("css/bundle.css is not the shell's stylesheets in order")
	}
	// A relative url() in a stylesheet resolves against the bundle's own directory: it must be the original's (css/ next to vendor/).
	if path.Dir(BundleStylesheet) != "css" {
		t.Errorf("the bundle stylesheet moved out of css/: %s", BundleStylesheet)
	}
	for _, l := range links {
		data, _ := fs.ReadFile(static, l)
		for _, m := range regexp.MustCompile(`url\(([^)]+)\)`).FindAllStringSubmatch(string(data), -1) {
			u := strings.Trim(m[1], `"' `)
			if strings.HasPrefix(u, "data:") || strings.HasPrefix(u, "#") || strings.HasPrefix(u, "/") {
				continue
			}
			if path.Dir(l) != "css" {
				t.Errorf("%s has a relative url() but is not in css/", l)
			}
		}
	}
}

// Same input, same bytes (every viewer gets one answer, and the server builds it once).
func TestBundleIsDeterministic(t *testing.T) {
	b, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	again, err := BuildBundle(static, index)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range b.Files {
		if !bytes.Equal(data, again.Files[name]) {
			t.Errorf("%s differs between two builds", name)
		}
	}
	if len(b.Files) != len(again.Files) {
		t.Errorf("%d files then %d", len(b.Files), len(again.Files))
	}
}

// The bundled prefix serves the bundle's files and, for every other path, the original.
func TestBundleOverlay(t *testing.T) {
	b, static := realBundle(t)
	o := b.FS(static)
	app, err := fs.ReadFile(o, "app.js")
	if err != nil || !bytes.Equal(app, b.Files["app.js"]) {
		t.Fatalf("app.js is not the bundle: %v", err)
	}
	orig, _ := fs.ReadFile(static, "theme_init.js") // a classic script: not a module of the family
	got, err := fs.ReadFile(o, "theme_init.js")
	if err != nil || !bytes.Equal(got, orig) {
		t.Errorf("a file the bundle does not replace is not the original: %v", err)
	}
	st, err := fs.Stat(o, "state.js")
	if err != nil || st.IsDir() || st.Size() != int64(len(b.Files["state.js"])) {
		t.Errorf("state.js stat: %v %v", st, err)
	}
	if _, err := fs.Stat(o, "no-such-file.js"); err == nil {
		t.Error("a missing file is found")
	}
}

func TestBundleDisabledBySwitch(t *testing.T) {
	t.Setenv("CORAL_NO_BUNDLE", "1")
	if !BundleDisabled() {
		t.Error("CORAL_NO_BUNDLE=1 does not disable the bundle")
	}
	t.Setenv("CORAL_NO_BUNDLE", "")
	if BundleDisabled() {
		t.Error("an empty CORAL_NO_BUNDLE disables the bundle")
	}
}

// A source that imports by a bare name or out of the tree is refused, not fetched from the disk.
func TestBundleRefusesImportsOutsideTheTree(t *testing.T) {
	mem := fakeFS{"app.js": "import 'fs';\n"}
	if _, err := BuildBundle(mem, nil); err == nil {
		t.Error("a bare import was bundled")
	}
	mem = fakeFS{"app.js": "import '../etc/passwd.js';\n"}
	if _, err := BuildBundle(mem, nil); err == nil {
		t.Error("an import out of the tree was bundled")
	}
}

type fakeFS map[string]string

func (f fakeFS) Open(name string) (fs.File, error) {
	if s, ok := f[name]; ok {
		return &memFile{name: path.Base(name), r: bytes.NewReader([]byte(s)), size: int64(len(s))}, nil
	}
	return nil, fs.ErrNotExist
}

// The bundle's own names are mangled (it has a source map); every export keeps its name, so the stubs and the tests that import by URL hold (#4326).
func TestBundleMangledNamesKeepExports(t *testing.T) {
	b, _ := realBundle(t)
	app := string(b.Files["app.js"])
	// splitTopLevel is a local helper of dom_morph.js that nothing imports: mangled away.
	if strings.Contains(app, "splitTopLevel") {
		t.Error("a module-local name is still in the bundle: identifiers are not mangled")
	}
	// morphHtml is exported by dom_morph.js: its stub re-exports it by name.
	stub := string(b.Files["dom_morph.js"])
	if !strings.Contains(stub, "morphHtml") {
		t.Errorf("dom_morph.js's stub does not re-export morphHtml: %s", stub)
	}
	if !strings.Contains(app, "$morphHtml") {
		t.Error("the bundle does not export morphHtml under its alias")
	}
}

// A tree whose local names were shortened (MinifyAsset, #7185: the release's static tree) still has its importOnce('./x.js') call sites found: the call reads e("./x.js") there, and a module not found is not
// registered with importOnce, so a later importOnce goes to the network for its stub, which waits on app.js's own top-level awaits: the stripped dashboard hung at start (the CDP gate's stripped job).
func TestImportOnceSpecsAreFoundInAMinifiedTree(t *testing.T) {
	_, static := realBundle(t)
	min := fstest.MapFS{}
	_ = fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, _ := fs.ReadFile(static, p)
		if strings.HasSuffix(p, ".js") && !strings.HasPrefix(p, "vendor/") {
			data = MinifyAsset(p, data)
		}
		min[p] = &fstest.MapFile{Data: data}
		return nil
	})
	want, got := importOnceSpecs(static), importOnceSpecs(min)
	if len(want) < 20 {
		t.Fatalf("the source tree has only %d importOnce specifiers: the scan is not reading it", len(want))
	}
	for m := range want {
		if !got[m] {
			t.Errorf("%s is imported with importOnce in the source but not found in the minified tree", m)
		}
	}
}

// The lazy modules (#8670) are built against the bundle's instance: a lazy file imports app.js and nothing else (a startup module's stub would be a request), except a
// group's member, whose URL is a stub of its group file. None failed to build, and every lazy module of the tree is covered.
func TestLazyModulesImportOnlyTheBundle(t *testing.T) {
	b, static := realBundle(t)
	if len(b.LazySkipped) > 0 {
		t.Fatalf("lazy modules that did not build (served as the original, with stub requests): %v", b.LazySkipped)
	}
	startup := map[string]bool{"app.js": true}
	for _, m := range b.Modules {
		startup[m] = true
	}
	want := lazyModules(static, startup)
	if len(want) < 100 {
		t.Fatalf("only %d lazy modules found: the walk is not reading the tree", len(want))
	}
	if strings.Join(b.Lazy, ",") != strings.Join(want, ",") {
		t.Errorf("the family covers %d lazy modules, the tree has %d: %v", len(b.Lazy), len(want), want)
	}
	memberOf := map[string]string{}
	for _, g := range LazyGroups {
		for _, m := range g.Members {
			memberOf[m] = g.Main
		}
	}
	imp := regexp.MustCompile(`(?:\bfrom|\bimport)\s*["'](\.{1,2}/[^"']+)["']`)
	for _, m := range b.Lazy {
		data, ok := b.Files[m]
		if !ok || len(data) == 0 {
			t.Errorf("lazy module %s has no file", m)
			continue
		}
		wantImport := "./app.js"
		if main, member := memberOf[m]; member {
			wantImport = "./" + main
		}
		for _, x := range imp.FindAllStringSubmatch(string(data), -1) {
			if x[1] != wantImport {
				t.Errorf("%s imports %s: a lazy file imports only %s", m, x[1], wantImport)
			}
		}
		if _, member := memberOf[m]; !member && !bytes.Contains(data, []byte("sourceMappingURL="+m+".map")) {
			t.Errorf("%s has no source map link", m)
		}
	}
}

// A group's main file holds the members and the main module in dependency order: every member is registered with importOnce (so the main module's own importOnce of it is
// answered with no request), comes before the modules that await it, and is awaited by something in the group (else it has no business there).
func TestLazyGroupsAreWholeAndInOrder(t *testing.T) {
	b, static := realBundle(t)
	startup := map[string]bool{"app.js": true}
	for _, m := range b.Modules {
		startup[m] = true
	}
	lazy := map[string]bool{}
	for _, m := range lazyModules(static, startup) {
		lazy[m] = true
	}
	seen := map[string]bool{}
	for _, g := range LazyGroups {
		pos := map[string]int{}
		for i, m := range g.Members {
			if !lazy[m] || seen[m] {
				t.Errorf("group %s: member %s is not a lazy module, or is in two groups", g.Main, m)
			}
			seen[m] = true
			pos[m] = i
		}
		if !lazy[g.Main] || seen[g.Main] {
			t.Errorf("group main %s is not a lazy module, or is a member", g.Main)
		}
		awaited := map[string]bool{}
		for _, who := range append(append([]string{}, g.Members...), g.Main) {
			data, err := fs.ReadFile(static, who)
			if err != nil {
				t.Fatal(err)
			}
			for _, dep := range importOnceCalls(data) {
				if i, member := pos[dep]; member {
					awaited[dep] = true
					if who != g.Main && i >= pos[who] {
						t.Errorf("group %s: %s awaits %s, which is listed after it", g.Main, who, dep)
					}
				}
			}
		}
		for _, m := range g.Members {
			if !awaited[m] {
				t.Errorf("group %s: no module of the group awaits %s", g.Main, m)
			}
			if !bytes.Contains(b.Files[g.Main], []byte(strconv.Quote(m))) {
				t.Errorf("group %s: the file does not register %s with importOnce", g.Main, m)
			}
			stub := string(b.Files[m])
			if len(stub) > 4096 || (strings.Contains(stub, "export {") && !strings.Contains(stub, "from './"+g.Main+"'")) {
				t.Errorf("%s is not a stub of %s: %q", m, g.Main, stub)
			}
			if got, want := stubNames(stub), mustExports(t, static, m); strings.Join(got, ",") != strings.Join(want, ",") {
				t.Errorf("the stub of %s exports %v, the module exports %v", m, got, want)
			}
		}
		for _, name := range mustExports(t, static, g.Main) {
			if name != "default" && !bytes.Contains(b.Files[g.Main], []byte(name)) {
				t.Errorf("group %s: the file does not export %s", g.Main, name)
			}
		}
	}
}

func mustExports(t *testing.T, static fs.FS, m string) []string {
	t.Helper()
	ex, err := exportNames(static, m)
	if err != nil {
		t.Fatal(err)
	}
	return ex
}

// The same tree builds the same bytes, lazy files included (the build id hashes them).
func TestLazyFilesAreDeterministic(t *testing.T) {
	b, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	again, err := BuildBundle(static, index)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range b.Lazy {
		if !bytes.Equal(b.Files[m], again.Files[m]) {
			t.Errorf("%s differs between two builds of one tree", m)
		}
	}
}

// The release's static tree is minified (MinifyAsset, tools/strip-static): the lazy families build from it too, with every group member registered.
func TestLazyFamiliesBuildFromAMinifiedTree(t *testing.T) {
	_, static := realBundle(t)
	min := fstest.MapFS{}
	_ = fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, _ := fs.ReadFile(static, p)
		if strings.HasSuffix(p, ".js") && !strings.HasPrefix(p, "vendor/") {
			data = MinifyAsset(p, data)
		}
		min[p] = &fstest.MapFile{Data: data}
		return nil
	})
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	b, err := BuildBundle(min, index)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.LazySkipped) > 0 {
		t.Fatalf("lazy modules that did not build from the minified tree: %v", b.LazySkipped)
	}
	for _, g := range LazyGroups {
		for _, m := range g.Members {
			if !bytes.Contains(b.Files[g.Main], []byte(strconv.Quote(m))) {
				t.Errorf("minified tree: group %s does not register %s", g.Main, m)
			}
		}
	}
}

// A lazy build that panics is not the server's end (#8705, Security's LOW): its goroutine recovers (safego), the module is listed in LazySkipped and is not in Files (so it is served as the
// original), and when it is a group's main file the members are not stubbed to a file that is not there.
func TestALazyBuildThatPanicsIsSkipped(t *testing.T) {
	_, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	real := buildLazy
	t.Cleanup(func() { buildLazy = real })
	const single, main = "docs.js", "workflows.js"
	buildLazy = func(static fs.FS, entry, name string, plugin api.Plugin) (lazyOutput, error) {
		if name == single || name == main {
			panic("the build of " + name + " blew up")
		}
		return real(static, entry, name, plugin)
	}
	before := safego.Panics()
	b, err := BuildBundle(static, index)
	if err != nil {
		t.Fatalf("a lazy build that panics took the bundle down: %v", err)
	}
	if got := safego.Panics() - before; got != 2 {
		t.Errorf("%d panics recovered, want 2", got)
	}
	for _, m := range []string{single, main} {
		if b.LazySkipped[m] == nil {
			t.Errorf("%s panicked and is not in LazySkipped: %v", m, b.LazySkipped)
		}
		if _, ok := b.Files[m]; ok {
			t.Errorf("%s has a file in the bundle although its build panicked", m)
		}
		for _, c := range b.Lazy {
			if c == m {
				t.Errorf("%s is listed as covered", m)
			}
		}
	}
	for _, g := range LazyGroups {
		if g.Main != main {
			continue
		}
		for _, m := range g.Members {
			if _, ok := b.Files[m]; ok {
				t.Errorf("member %s of the skipped group %s is a stub of a file that is not there", m, main)
			}
			if b.Files[m] != nil || b.LazySkipped[m] != nil {
				t.Errorf("member %s is neither the original nor skipped cleanly", m)
			}
		}
	}
	if len(b.LazySkipped) != 2 {
		t.Errorf("LazySkipped is %v, want only the two panicked", b.LazySkipped)
	}
	// Everything else is built as before, and the bundle itself is whole.
	if len(b.Files["app.js"]) == 0 || len(b.Lazy) < 100 {
		t.Errorf("the rest of the family is not built: app.js %d bytes, %d lazy", len(b.Files["app.js"]), len(b.Lazy))
	}
	// The overlay serves a skipped module as the original.
	got, err := fs.ReadFile(b.FS(static), single)
	orig, _ := fs.ReadFile(static, single)
	if err != nil || !bytes.Equal(got, orig) {
		t.Errorf("%s is not served as the original: %v", single, err)
	}
}
