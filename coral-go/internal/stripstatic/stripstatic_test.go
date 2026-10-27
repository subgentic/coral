package stripstatic

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/frontend"
)

var realStatic = filepath.Join("..", "..", "pkg", "frontend", "static")

// The overlay ships exactly what the server serves: every replaced file is MinifyAsset of its source, and every JS and CSS file the overlay leaves alone is one MinifyAsset leaves as it is (so a file cannot
// be forgotten or changed by something else). Runs in the default test set: it is the proof that the release's bytes are the served bytes.
func TestOverlayIsMinifyAssetFileByFile(t *testing.T) {
	out := ownerOnly(t, t.TempDir())
	res, err := Generate(realStatic, out)
	require.NoError(t, err)
	require.NoError(t, Validate(res.Overlay, realStatic))
	raw, err := os.ReadFile(res.Overlay)
	require.NoError(t, err)
	var ov overlayJSON
	require.NoError(t, json.Unmarshal(raw, &ov))
	abs, _ := filepath.Abs(realStatic)
	replaced := map[string]bool{}
	for src, dst := range ov.Replace {
		if src == prebuiltKey(abs) {
			continue // the prebuilt bundled family: TestOverlayAddsThePrebuiltBundleOfTheStrippedTree
		}
		rel, err := filepath.Rel(abs, src)
		require.NoError(t, err)
		rel = filepath.ToSlash(rel)
		replaced[rel] = true
		source, err := os.ReadFile(src)
		require.NoError(t, err)
		got, err := os.ReadFile(dst)
		require.NoError(t, err)
		assert.Equal(t, string(frontend.MinifyAsset(rel, source)), string(got), "%s is not what the server serves", rel)
		assert.Less(t, len(got), len(source), "%s did not shrink", rel)
		// The server minifies what it serves, whatever the binary holds: minifying the stripped copy again must leave it as it is, so a stripped binary serves the bytes a source one does.
		assert.Equal(t, string(got), string(frontend.MinifyAsset(rel, got)), "%s: serving the stripped copy would minify it again to other bytes", rel)
	}
	require.NoError(t, filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(abs, p)
		rel = filepath.ToSlash(rel)
		if replaced[rel] {
			return nil
		}
		data, _ := os.ReadFile(p)
		assert.Equal(t, string(data), string(frontend.MinifyAsset(rel, data)), "%s is minified by the server but not in the overlay", rel)
		assert.False(t, minified(rel) && len(frontend.MinifyAsset(rel, data)) < len(data), "%s", rel)
		return nil
	}))
	assert.Equal(t, res.Files, len(ov.Replace)-1, "the stripped files and the one prebuilt bundle")
	assert.Greater(t, res.SourceBytes-res.StrippedBytes, int64(500_000), "the strip saves hundreds of KB: %+v", res)
	// everything it wrote is inside its own folder
	for _, dst := range ov.Replace {
		assert.True(t, strings.HasPrefix(dst, out), dst)
	}
}

// ownerOnly makes dir what Generate's folder is (t.TempDir is 0755 on some systems).
func ownerOnly(t *testing.T, dir string) string {
	t.Helper()
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Chmod(dir, 0o700))
	}
	return dir
}

func writeOverlay(t *testing.T, dir string, replace map[string]string) string {
	t.Helper()
	b, err := json.Marshal(overlayJSON{Replace: replace})
	require.NoError(t, err)
	p := filepath.Join(dir, File)
	require.NoError(t, os.WriteFile(p, b, 0o600))
	return p
}

// An overlay can replace any file the compiler reads, Go sources included: Validate must refuse every key but a JS or CSS file of the static tree, and every target outside the overlay's folder (Security, #6208).
func TestValidateRefusesAnythingButStaticJSAndCSS(t *testing.T) {
	abs, _ := filepath.Abs(realStatic)
	dir := ownerOnly(t, t.TempDir())
	target := filepath.Join(dir, "x.js")
	require.NoError(t, os.WriteFile(target, []byte("x"), 0o600))
	goFile, _ := filepath.Abs(filepath.Join("..", "..", "internal", "stripstatic", "stripstatic.go"))
	other := filepath.Join(t.TempDir(), "elsewhere.js")
	require.NoError(t, os.WriteFile(other, []byte("x"), 0o600))
	ok := filepath.Join(abs, "app.js")
	for name, replace := range map[string]map[string]string{
		"a Go file":                 {goFile: target},
		"a Go file in the frontend": {filepath.Join(abs, "..", "frontend.go"): target},
		"a dotdot key":              {filepath.Join(abs, "sub", "..", "..", "frontend.go"): target},
		"a relative key":            {"app.js": target},
		"outside the static tree":   {filepath.Join(filepath.Dir(abs), "app.js"): target},
		"an html file":              {filepath.Join(abs, "x.html"): target},
		"vendor":                    {filepath.Join(abs, "vendor", "marked.min.js"): target},
		"agent docs":                {filepath.Join(abs, "agent_docs", "x.js"): target},
		"a target elsewhere":        {ok: other},
		"a relative target":         {ok: "x.js"},
		"a dotdot target":           {ok: filepath.Join(dir, "..", "x.js")},
		"a target that is not":      {ok: filepath.Join(dir, "missing.js")},
		"nothing":                   {},
	} {
		p := writeOverlay(t, dir, replace)
		assert.Error(t, Validate(p, realStatic), name)
	}
	assert.NoError(t, Validate(writeOverlay(t, dir, map[string]string{ok: target}), realStatic), "a JS file of the static tree to a file in the overlay's folder is fine")
}

func TestGenerateRefusesToShipNothingOrWithMinifyOff(t *testing.T) {
	src := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(src, "a.js"), []byte("a=1;"), 0o600)) // already as small as it gets
	_, err := Generate(src, t.TempDir())
	assert.ErrorContains(t, err, "nothing under")
	t.Setenv("CORAL_NO_MINIFY", "1")
	_, err = Generate(realStatic, ownerOnly(t, t.TempDir()))
	assert.ErrorContains(t, err, "CORAL_NO_MINIFY")
}

// The release verify scripts look for a comment of the source in the server binary (tests/release/strip_marker.txt): it must still be a comment in a static file, or the check passes for the wrong reason.
func TestStripMarkerIsStillInTheSource(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "release", "strip_marker.txt"))
	require.NoError(t, err)
	marker := strings.TrimSpace(string(raw))
	require.NotEmpty(t, marker)
	found := false
	require.NoError(t, filepath.WalkDir(realStatic, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !minified(strings.TrimPrefix(filepath.ToSlash(p), filepath.ToSlash(realStatic)+"/")) {
			return err
		}
		b, _ := os.ReadFile(p)
		if strings.Contains(string(b), marker) {
			found = true
			assert.NotContains(t, string(frontend.MinifyAsset(strings.TrimPrefix(filepath.ToSlash(p), filepath.ToSlash(realStatic)+"/"), b)), marker, "%s: the marker survives minifying, so a stripped binary would carry it", p)
		}
		return nil
	}))
	assert.True(t, found, "no JS or CSS file of the static tree holds %q any more: pick another comment line for tests/release/strip_marker.txt", marker)
}

// A folder or file another user could change is refused (Unix), and so is a symlink standing in for a target (Security, #6208).
func TestValidateRefusesAnOpenFolderOrASymlinkTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits: the Windows build step makes an owner-only folder (-out)")
	}
	abs, _ := filepath.Abs(realStatic)
	ok := filepath.Join(abs, "app.js")
	dir := ownerOnly(t, t.TempDir())
	target := filepath.Join(dir, "x.js")
	require.NoError(t, os.WriteFile(target, []byte("x"), 0o600))
	p := writeOverlay(t, dir, map[string]string{ok: target})
	require.NoError(t, Validate(p, realStatic))

	require.NoError(t, os.Chmod(dir, 0o777))
	assert.ErrorContains(t, Validate(p, realStatic), "owner-only", "a folder open to others")
	require.NoError(t, os.Chmod(dir, 0o700))

	require.NoError(t, os.Chmod(target, 0o666))
	assert.ErrorContains(t, Validate(p, realStatic), "written by other users", "a file others can write")
	require.NoError(t, os.Chmod(target, 0o600))

	real := filepath.Join(t.TempDir(), "real.js")
	require.NoError(t, os.WriteFile(real, []byte("x"), 0o600))
	link := filepath.Join(dir, "link.js")
	require.NoError(t, os.Symlink(real, link))
	assert.ErrorContains(t, Validate(writeOverlay(t, dir, map[string]string{ok: link}), realStatic), "not a regular file", "a symlink target")
}

func TestCheckOutDir(t *testing.T) {
	root := t.TempDir()
	mk := func(name string) string {
		d := filepath.Join(root, name)
		require.NoError(t, os.Mkdir(d, 0o700))
		return d
	}
	assert.NoError(t, CheckOutDir(mk("coral-static-a")))
	assert.Error(t, CheckOutDir(mk("other")), "wrong name")
	assert.Error(t, CheckOutDir(filepath.Join(root, "coral-static-missing")), "missing")
	full := mk("coral-static-full")
	require.NoError(t, os.WriteFile(filepath.Join(full, "x"), []byte("x"), 0o600))
	assert.Error(t, CheckOutDir(full), "not empty")
	if runtime.GOOS != "windows" {
		open := mk("coral-static-open")
		require.NoError(t, os.Chmod(open, 0o777))
		assert.Error(t, CheckOutDir(open), "open to others")
		require.NoError(t, os.Symlink(mk("coral-static-real"), filepath.Join(root, "coral-static-link")))
		assert.Error(t, CheckOutDir(filepath.Join(root, "coral-static-link")), "symlink")
	}
}

// The overlay also adds the bundled family built from the stripped tree (#8760): at the one path go:embed reads it from, naming the tree it was built from. Rebuilding that tree's name here,
// from the sources and the stripped files the overlay holds, gives the same hash: what a release server compares with the tree it embeds.
func TestOverlayAddsThePrebuiltBundleOfTheStrippedTree(t *testing.T) {
	out := ownerOnly(t, t.TempDir())
	res, err := Generate(realStatic, out)
	require.NoError(t, err)
	abs, _ := filepath.Abs(realStatic)
	raw, err := os.ReadFile(res.Overlay)
	require.NoError(t, err)
	var ov overlayJSON
	require.NoError(t, json.Unmarshal(raw, &ov))
	dst, ok := ov.Replace[prebuiltKey(abs)]
	require.True(t, ok, "the overlay does not add the prebuilt bundle")
	assert.Equal(t, filepath.Join(filepath.Dir(abs), "prebuilt", "bundle.gob.gz"), prebuiltKey(abs))
	assert.Equal(t, filepath.Join(out, "prebuilt", "bundle.gob.gz"), dst)
	f, err := os.Open(dst)
	require.NoError(t, err)
	defer f.Close()
	b, hash, err := frontend.DecodePrebuilt(f)
	require.NoError(t, err)
	assert.Greater(t, len(b.Files), 500)
	assert.Empty(t, b.LazySkipped)
	assert.Equal(t, res.Prebuilt > 1_000_000, true, "the prebuilt file is a few MB: %d", res.Prebuilt)

	// The tree a release binary embeds: the source tree with the overlay's files in place of what they replace.
	tree := fstest.MapFS{}
	require.NoError(t, filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(abs, p)
		src := p
		if repl, ok := ov.Replace[p]; ok {
			src = repl
		}
		data, err := os.ReadFile(src)
		require.NoError(t, err)
		tree[filepath.ToSlash(rel)] = &fstest.MapFile{Data: data}
		return nil
	}))
	index, _ := fs.ReadFile(frontend.Templates, "templates/index.html")
	want, err := frontend.BundleInputHash(tree, index)
	require.NoError(t, err)
	assert.Equal(t, want, hash, "the prebuilt bundle names another tree than the one the overlay makes")

	// go:embed would leave out a dotfile or an underscore file the walk above reads: the JS and CSS the hash covers must be the same set in both.
	embedded := map[string]bool{}
	sub, _ := fs.Sub(frontend.Static, "static")
	require.NoError(t, fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && (strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css")) {
			embedded[p] = true
		}
		return nil
	}))
	for p := range tree {
		if (strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css")) && !embedded[p] {
			t.Errorf("%s is read by the generator but not embedded: the prebuilt hash would never match", p)
		}
	}
	assert.Equal(t, len(embedded), func() int {
		n := 0
		for p := range tree {
			if strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css") {
				n++
			}
		}
		return n
	}())
}

// The overlay may add exactly one file that is not a static JS or CSS file: the prebuilt bundle, at its path, named bundle.gob.gz, inside the overlay's own folder.
func TestValidateAllowsOnlyThePrebuiltBundleBesidesStaticFiles(t *testing.T) {
	dir := ownerOnly(t, t.TempDir())
	abs, _ := filepath.Abs(realStatic)
	good := filepath.Join(dir, "prebuilt", "bundle.gob.gz")
	require.NoError(t, os.MkdirAll(filepath.Dir(good), 0o700))
	require.NoError(t, os.WriteFile(good, []byte("x"), 0o600))
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Chmod(filepath.Dir(good), 0o700))
	}
	js := filepath.Join(abs, "app.js")
	jsTarget := filepath.Join(dir, "app.js")
	require.NoError(t, os.WriteFile(jsTarget, []byte("x"), 0o600))
	ok := writeOverlay(t, dir, map[string]string{js: jsTarget, prebuiltKey(abs): good})
	require.NoError(t, Validate(ok, realStatic), "the prebuilt bundle at its path is allowed")

	for name, extra := range map[string]string{
		"another file in the prebuilt folder": filepath.Join(filepath.Dir(prebuiltKey(abs)), "other.js"),
		"the template":                        filepath.Join(filepath.Dir(abs), "templates", "index.html"),
		"a Go file":                           filepath.Join(filepath.Dir(abs), "bundle.go"),
	} {
		bad := writeOverlay(t, dir, map[string]string{js: jsTarget, extra: good})
		assert.Error(t, Validate(bad, realStatic), name)
	}
	other := filepath.Join(dir, "prebuilt", "bundle.bin")
	require.NoError(t, os.WriteFile(other, []byte("x"), 0o600))
	assert.Error(t, Validate(writeOverlay(t, dir, map[string]string{js: jsTarget, prebuiltKey(abs): other}), realStatic), "the prebuilt target must be named bundle.gob.gz")
	outside := filepath.Join(t.TempDir(), "bundle.gob.gz")
	require.NoError(t, os.WriteFile(outside, []byte("x"), 0o600))
	assert.Error(t, Validate(writeOverlay(t, dir, map[string]string{js: jsTarget, prebuiltKey(abs): outside}), realStatic), "the prebuilt target must be inside the overlay's folder")
}
