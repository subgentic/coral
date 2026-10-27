package frontend

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

// exportNamesBatch lists the names each of modules exports, in ONE esbuild build (#8760): exportNames made one api.Build per module (about 420 of them at start), each paying
// esbuild's per-build set-up (a defines table of 20 to 50 MB of garbage) for a few lines of output. Here every module is an entry point, every import of it is left external so the
// outputs are the modules alone, and the metafile says what each exports. The result is the same as exportNames, module by module (TestExportNamesBatchIsExportNames).
func exportNamesBatch(static fs.FS, modules []string) (map[string][]string, error) {
	entries := make([]api.EntryPoint, len(modules))
	for i, m := range modules {
		entries[i] = api.EntryPoint{InputPath: "./" + m, OutputPath: strings.TrimSuffix(m, ".js")}
	}
	res := api.Build(api.BuildOptions{
		EntryPointsAdvanced: entries,
		Bundle:              true,
		Format:              api.FormatESModule,
		Target:              api.ESNext,
		Outdir:              "/out",
		Write:               false,
		Metafile:            true,
		LogLevel:            api.LogLevelSilent,
		Plugins:             []api.Plugin{exportsPlugin(static)},
	})
	if err := buildError(res); err != nil {
		return nil, err
	}
	var mf struct {
		Outputs map[string]struct {
			Exports    []string
			EntryPoint string
		}
	}
	if err := json.Unmarshal([]byte(res.Metafile), &mf); err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(modules))
	for _, o := range mf.Outputs {
		name, ok := strings.CutPrefix(o.EntryPoint, "static:")
		if !ok {
			continue
		}
		ex := append([]string(nil), o.Exports...)
		sort.Strings(ex)
		out[name] = ex
	}
	for _, m := range modules {
		if _, ok := out[m]; !ok {
			return nil, fmt.Errorf("bundle: no export list for %s", m)
		}
	}
	return out, nil
}

// exportsPlugin resolves an entry point to the module in the static tree and leaves every other import external: the entry is read alone.
func exportsPlugin(fsys fs.FS) api.Plugin {
	const ns = "static"
	return api.Plugin{Name: "exports-only", Setup: func(b api.PluginBuild) {
		b.OnResolve(api.OnResolveOptions{Filter: `.*`}, func(a api.OnResolveArgs) (api.OnResolveResult, error) {
			if a.Kind != api.ResolveEntryPoint {
				return api.OnResolveResult{Path: a.Path, External: true}, nil
			}
			name := path.Clean(strings.TrimPrefix(a.Path, "./"))
			if strings.HasPrefix(name, "../") || name == ".." || path.IsAbs(name) {
				return api.OnResolveResult{}, fmt.Errorf("bundle: %q leaves the static tree", a.Path)
			}
			return api.OnResolveResult{Path: name, Namespace: ns}, nil
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
			return api.OnLoadResult{Contents: &src, Loader: api.LoaderJS}, nil
		})
	}}
}
