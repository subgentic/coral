package frontend

import (
	"fmt"
	"io"
	"io/fs"
	"path"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/evanw/esbuild/pkg/api"
	"github.com/subgentic/coral/internal/safego"
)

// The lazy modules of the bundled family (#8670, plan (c) of #8663).
//
// app.js holds the startup graph, and every startup module's URL is a stub that re-exports the bundle's instance. A lazy module (one a
// tab or a dialog loads with importOnce when it is first used) was served as the original file, whose static imports are all startup modules:
// each of those was a request for a stub. A first visit to Workflows cost 21 stub requests, Analytics 12 (36 over the seven main tabs).
//
// Here a lazy module is built with its startup imports pointing straight at the bundle's instance: the output imports
// `{ m12$a as a } from './app.js'` (the modules app.js already runs) and nothing else, so the stubs are never requested. Its other lazy
// modules are still loaded the way they are today, with importOnce, one instance each.
//
// LazyGroups go a step further for the tab families that always load together: the main module's URL serves ONE file holding the
// members and the main module, in dependency order, each member registering its namespace with importOnce (the way the startup modules
// do), so the main module's own `await importOnce('./member.js')` is answered from the registry with no request. A member's own URL is a
// stub that re-exports the group file's instance, so a member asked for first, by importOnce or by URL, is still the one instance.
// CORAL_NO_BUNDLE=1 turns all of this off with the rest of the family.

// LazyGroup is a main module and the lazy modules it awaits at its top level (its importOnce targets), built into the main module's URL.
// Members are listed in dependency order: a member's own importOnce targets that are in the group come before it.
type LazyGroup struct {
	Main    string
	Members []string
}

// LazyGroups are the tab families a first visit loads whole: Automations (the folders, the workflows' pages, their editor, run page and Build with Agent, and the folders' filters)
// and Analytics (the dashboard, its views, charts, an agent's page and the two team views). Each was 4 to 6 files plus their stubs. The shared pieces the Inbox loads too
// (the folder list, the toolbar) stay files of their own, so the Inbox's first visit does not load Automations.
var LazyGroups = []LazyGroup{
	{Main: "automations.js", Members: []string{"workflow_run_html.js", "workflow_agent.js", "time_limit.js", "workflow_templates.js", "workflow_editor.js", "workflows.js", "automation_filters.js"}},
	{Main: "cost_dashboard.js", Members: []string{"cost_data.js", "analytics_views.js", "analytics_series.js", "analytics_agent.js", "analytics_terms.js", "analytics_spend.js", "analytics_efficiency.js"}},
}

// notBundledLazy are files that are scripts, not modules the dashboard loads with importOnce: served as they are.
var notBundledLazy = map[string]bool{"theme_init.js": true, "sw_register.js": true, "sw.js": true}

// lazyModules lists the modules (paths under static/, at its top level) a lazy build covers: every .js file that is not a startup module, vendored,
// in a folder (the cloud pages' own entries) or one of notBundledLazy.
func lazyModules(static fs.FS, startup map[string]bool) []string {
	var out []string
	_ = fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != "." {
				return fs.SkipDir // the top level only
			}
			return nil
		}
		if strings.HasSuffix(p, ".js") && !strings.HasSuffix(p, ".min.js") && !startup[p] && !notBundledLazy[p] {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

// startupStub is the source of a startup module's stub: its names re-exported, as live bindings, from the bundle's instance (see BuildBundle).
func startupStub(names []string, alias string, appURL string) string {
	if len(names) == 0 {
		return "export {};\n"
	}
	var s strings.Builder
	s.WriteString("export { ")
	for j, e := range names {
		if j > 0 {
			s.WriteString(", ")
		}
		fmt.Fprintf(&s, "%s$%s as %s", alias, e, e)
	}
	fmt.Fprintf(&s, " } from '%s';\n", appURL)
	return s.String()
}

// lazyPlugin resolves the imports of a lazy build: a startup module is the bundle's instance (its stub's source, with ./app.js left external),
// anything else is read from the static tree as in embeddedFiles. registered names the modules that register their namespace with importOnce.
func lazyPlugin(fsys fs.FS, startup map[string]bool, alias map[string]string, exports map[string][]string, registered map[string]bool) api.Plugin {
	const ns, startupNS = "static", "startup"
	return api.Plugin{Name: "lazy-static", Setup: func(b api.PluginBuild) {
		b.OnResolve(api.OnResolveOptions{Filter: `.*`}, func(a api.OnResolveArgs) (api.OnResolveResult, error) {
			if a.Namespace == startupNS && a.Path == "./app.js" {
				return api.OnResolveResult{Path: "./app.js", External: true}, nil
			}
			if !strings.HasPrefix(a.Path, "./") && !strings.HasPrefix(a.Path, "../") {
				return api.OnResolveResult{}, fmt.Errorf("bundle: only relative imports are bundled, got %q (from %s)", a.Path, a.Importer)
			}
			dir := ""
			if a.Namespace == ns {
				dir = path.Dir(a.Importer)
			}
			name := path.Clean(path.Join(dir, a.Path))
			if strings.HasPrefix(name, "../") || name == ".." {
				return api.OnResolveResult{}, fmt.Errorf("bundle: %q leaves the static tree (from %s)", a.Path, a.Importer)
			}
			if startup[name] {
				return api.OnResolveResult{Path: name, Namespace: startupNS}, nil
			}
			return api.OnResolveResult{Path: name, Namespace: ns}, nil
		})
		b.OnLoad(api.OnLoadOptions{Filter: `.*`, Namespace: startupNS}, func(a api.OnLoadArgs) (api.OnLoadResult, error) {
			src := startupStub(exports[a.Path], alias[a.Path], "./app.js")
			return api.OnLoadResult{Contents: &src, Loader: api.LoaderJS}, nil
		})
		b.OnLoad(api.OnLoadOptions{Filter: `.*`, Namespace: ns}, func(a api.OnLoadArgs) (api.OnLoadResult, error) {
			f, err := fsys.Open(a.Path)
			if err != nil {
				return api.OnLoadResult{}, err
			}
			defer f.Close()
			data, err := io.ReadAll(f)
			if err != nil {
				return api.OnLoadResult{}, err
			}
			src := string(data)
			if registered[a.Path] {
				src += fmt.Sprintf("\nimport * as __bundledSelf from './%s';\nimport { registerBundled as __registerBundled } from './import_once.js';\n__registerBundled({ %q: __bundledSelf });\n", path.Base(a.Path), a.Path)
			}
			return api.OnLoadResult{Contents: &src, Loader: api.LoaderJS}, nil
		})
	}}
}

// lazyOutput is one lazy build's files: the module (named name) and its source map.
type lazyOutput struct{ js, mapFile []byte }

// buildLazy is how one lazy file is built: a variable so a test can make a build panic (TestALazyBuildThatPanicsIsSkipped).
var buildLazy = buildLazyFile

// buildLazyFile builds entry (source text) into the file name, with the options of the startup bundle's final build.
func buildLazyFile(static fs.FS, entry, name string, plugin api.Plugin) (lazyOutput, error) {
	res := api.Build(api.BuildOptions{
		Stdin:             &api.StdinOptions{Contents: entry, Sourcefile: name, Loader: api.LoaderJS, ResolveDir: "/"},
		Bundle:            true,
		Format:            api.FormatESModule,
		Target:            api.ESNext,
		Charset:           api.CharsetUTF8,
		LegalComments:     api.LegalCommentsInline,
		Outfile:           "/out/" + name,
		Write:             false,
		LogLevel:          api.LogLevelSilent,
		Plugins:           []api.Plugin{plugin},
		MinifyWhitespace:  true,
		MinifySyntax:      true,
		MinifyIdentifiers: true,
		Sourcemap:         api.SourceMapLinked,
		SourcesContent:    api.SourcesContentInclude,
	})
	if err := buildError(res); err != nil {
		return lazyOutput{}, err
	}
	var out lazyOutput
	for _, f := range res.OutputFiles {
		switch {
		case strings.HasSuffix(f.Path, ".js.map"):
			out.mapFile = f.Contents
		case strings.HasSuffix(f.Path, ".js"):
			out.js = f.Contents
		}
	}
	if len(out.js) == 0 {
		return lazyOutput{}, fmt.Errorf("bundle: esbuild produced no %s", name)
	}
	return out, nil
}

// reexport is the entry text that exposes module m's exports (a default one included) under their own names.
func reexport(m string, names []string) string {
	s := fmt.Sprintf("export * from './%s';\n", m)
	for _, n := range names {
		if n == "default" {
			s += fmt.Sprintf("export { default } from './%s';\n", m)
		}
	}
	return s
}

// buildLazyModules builds every lazy module of the family, with its groups, and returns the files to add to the bundle, the modules covered and the modules
// whose build failed (served as the original file: a lazy module that does not build must not take the dashboard's bundle down).
func buildLazyModules(static fs.FS, startup map[string]bool, alias map[string]string, exports map[string][]string, lazy []string, lazyExports map[string][]string) (files map[string][]byte, covered []string, skipped map[string]error, err error) {
	lazySet := map[string]bool{}
	for _, m := range lazy {
		lazySet[m] = true
	}
	inGroup := map[string]bool{}
	registered := map[string]bool{}
	for _, g := range LazyGroups {
		if !lazySet[g.Main] {
			return nil, nil, nil, fmt.Errorf("bundle: lazy group main %s is not a lazy module", g.Main)
		}
		inGroup[g.Main] = true
		for _, m := range g.Members {
			if !lazySet[m] || inGroup[m] {
				return nil, nil, nil, fmt.Errorf("bundle: lazy group member %s of %s is not a lazy module, or is in two groups", m, g.Main)
			}
			inGroup[m] = true
			registered[m] = true
		}
	}
	plugin := lazyPlugin(static, startup, alias, exports, registered)

	type job struct {
		name   string   // the file's own name
		entry  string   // its entry text
		stubs  []string // the group's members, whose own URLs become stubs
		prefix string   // the alias prefix of the group's members
	}
	var jobs []job
	for gi, g := range LazyGroups {
		var e strings.Builder
		for _, m := range g.Members {
			fmt.Fprintf(&e, "import './%s';\n", m)
		}
		fmt.Fprintf(&e, "import './%s';\n", g.Main)
		e.WriteString(reexport(g.Main, lazyExports[g.Main]))
		for mi, m := range g.Members {
			if len(lazyExports[m]) == 0 {
				continue
			}
			e.WriteString("export { ")
			for j, n := range lazyExports[m] {
				if j > 0 {
					e.WriteString(", ")
				}
				fmt.Fprintf(&e, "%s as l%d_%d$%s", n, gi, mi, n)
			}
			fmt.Fprintf(&e, " } from './%s';\n", m)
		}
		jobs = append(jobs, job{name: g.Main, entry: e.String(), stubs: g.Members, prefix: fmt.Sprintf("l%d_", gi)})
	}
	for _, m := range lazy {
		if !inGroup[m] {
			jobs = append(jobs, job{name: m, entry: reexport(m, lazyExports[m])})
		}
	}

	files = map[string][]byte{}
	skipped = map[string]error{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, runtime.NumCPU())
	for _, j := range jobs {
		wg.Add(1)
		sem <- struct{}{}
		go func(j job) {
			defer safego.Recover("lazy-bundle") // a panic in a build is a module served as the original (below), not the server's end
			defer wg.Done()
			defer func() { <-sem }()
			out, e := buildLazy(static, j.entry, j.name, plugin)
			mu.Lock()
			defer mu.Unlock()
			if e != nil {
				skipped[j.name] = e
				return
			}
			files[j.name] = out.js
			if len(out.mapFile) > 0 {
				files[j.name+".map"] = out.mapFile
			}
			covered = append(covered, j.name)
		}(j)
	}
	wg.Wait()
	for _, j := range jobs {
		if _, built := files[j.name]; !built && skipped[j.name] == nil {
			skipped[j.name] = fmt.Errorf("bundle: the build of %s panicked", j.name)
		}
	}
	// A member's URL is a stub that re-exports the group file's instance.
	for gi, g := range LazyGroups {
		if _, bad := skipped[g.Main]; bad {
			continue
		}
		for mi, m := range g.Members {
			var s strings.Builder
			if len(lazyExports[m]) == 0 {
				s.WriteString("export {};\n")
			} else {
				s.WriteString("export { ")
				for j, n := range lazyExports[m] {
					if j > 0 {
						s.WriteString(", ")
					}
					fmt.Fprintf(&s, "l%d_%d$%s as %s", gi, mi, n, n)
				}
				fmt.Fprintf(&s, " } from './%s';\n", g.Main)
			}
			files[m] = []byte(s.String())
			covered = append(covered, m)
		}
	}
	sort.Strings(covered)
	return files, covered, skipped, nil
}
