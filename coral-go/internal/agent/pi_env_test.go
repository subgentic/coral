package agent

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11093/#11102 (Security's 3b): the variables the Pi extension passes to a hook program are GENERATED from the hook sources, not hand-written: this test reads which variables internal/hooks and the
// cmd/coral-hook-* programs read (os.Getenv and os.LookupEnv) and fails when one is read that piHookEnvNames does not have (the child would be starved) or piHookEnvNames has one that no hook reads (it would be
// fed for nothing), so a later change to a hook cannot silently do either.

// piEnvReadSites are the places where a variable's name is not a literal in the call (a loop over a list), each with the names it reads: reviewed by hand, and the test fails when such a site changes shape.
var piEnvReadSites = map[string][]string{
	"internal/hooks/cache.go": {"CORAL_DATA_DIR", "CORAL_DIR"},
}

func TestPiExtensionEnvListIsGeneratedFromTheHookSources(t *testing.T) {
	roots, err := filepath.Glob("../../cmd/coral-hook-*")
	require.NoError(t, err)
	require.NotEmpty(t, roots, "the hook programs' folders")
	dirs := append([]string{"../hooks"}, roots...)

	consts := map[string]string{} // package-level string constants of the packages the hooks read names from
	for _, d := range append(append([]string{}, dirs...), "../agentenv") {
		for name, v := range stringConsts(t, d) {
			consts[name] = v
		}
	}
	found := map[string]bool{}
	for _, d := range dirs {
		for file, f := range parseDir(t, d) {
			rel := strings.TrimPrefix(filepath.ToSlash(filepath.Join(d, file)), "../../")
			rel = strings.TrimPrefix(rel, "../")
			rel = "internal/" + strings.TrimPrefix(rel, "internal/") // ../hooks/x.go -> internal/hooks/x.go
			if strings.HasPrefix(filepath.ToSlash(d), "../../cmd/") {
				rel = "cmd/" + strings.TrimPrefix(filepath.ToSlash(filepath.Join(d, file)), "../../cmd/")
			}
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) != 1 {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || (sel.Sel.Name != "Getenv" && sel.Sel.Name != "LookupEnv") {
					return true
				}
				if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != "os" {
					return true
				}
				switch a := call.Args[0].(type) {
				case *ast.BasicLit:
					v, err := strconv.Unquote(a.Value)
					require.NoError(t, err)
					found[v] = true
				case *ast.Ident:
					if v, ok := consts[a.Name]; ok {
						found[v] = true
					} else if names, ok := piEnvReadSites[rel]; ok {
						for _, v := range names {
							found[v] = true
						}
					} else {
						t.Errorf("%s reads the environment through %q, which is neither a literal nor a known constant: add the site to piEnvReadSites with the names it reads", rel, a.Name)
					}
				case *ast.SelectorExpr:
					if v, ok := consts[a.Sel.Name]; ok {
						found[v] = true
					} else {
						t.Errorf("%s reads the environment through %s.%s, which is not a known constant", rel, "pkg", a.Sel.Name)
					}
				default:
					t.Errorf("%s reads the environment with a name this census cannot read", rel)
				}
				return true
			})
		}
	}
	want := map[string]bool{}
	for n := range found {
		want[n] = true
	}
	for _, n := range piRuntimeEnv {
		want[n] = true
	}
	var wantList []string
	for n := range want {
		wantList = append(wantList, n)
	}
	sort.Strings(wantList)
	got := append([]string{}, piHookEnvNames...)
	sort.Strings(got)
	assert.Equal(t, wantList, got, "piHookEnvNames must be exactly what the hook sources read plus piRuntimeEnv: a variable a hook reads is missing, or one is listed that no hook reads")
	for _, n := range found {
		_ = n
	}
}

// No provider key, cloud credential or token of another service can ever be on the list.
func TestPiExtensionEnvListHasNoProviderSecrets(t *testing.T) {
	secret := regexp.MustCompile(`(?i)(^|_)(API_?KEY|SECRET|PASSWORD|PASSWD)(_|$)|^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|GITHUB|GH|GITLAB|HF|HUGGINGFACE|OPENROUTER|MISTRAL|XAI|GROQ)_`)
	for _, n := range piHookEnvNames {
		assert.False(t, secret.MatchString(n), "%s looks like a provider or cloud credential: it must never reach a child", n)
		if n != "CORAL_SESSION_TOKEN" {
			assert.False(t, strings.Contains(strings.ToUpper(n), "TOKEN"), "%s: the session token is the only token a hook may be given (the extension passes it on to the hook program and to nothing else)", n)
		}
	}
	assert.Contains(t, piHookEnvNames, "CORAL_SESSION_TOKEN", "the hook program needs the agent's own session token")
}

func parseDir(t *testing.T, dir string) map[string]*ast.File {
	t.Helper()
	out := map[string]*ast.File{}
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	require.NoError(t, err)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), f, nil, 0)
		require.NoError(t, err, f)
		out[filepath.Base(f)] = parsed
	}
	return out
}

func stringConsts(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, f := range parseDir(t, dir) {
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, spec := range gd.Specs {
				vs := spec.(*ast.ValueSpec)
				for i, name := range vs.Names {
					if i < len(vs.Values) {
						if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
							if v, err := strconv.Unquote(lit.Value); err == nil {
								out[name.Name] = v
							}
						}
					}
				}
			}
		}
	}
	return out
}
