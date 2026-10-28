package frontend

import (
	"bytes"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"
	"sync/atomic"

	"github.com/evanw/esbuild/pkg/api"
)

// MinifyAsset returns the dashboard file name (a path under static/) minified, or data itself when it is not one to minify or minifying
// fails (#4203). The dashboard is served as separate ES modules from the embedded tree, comments and indentation included; on a slow
// link the bytes are the load time (about 8.5 ms per KB on 4g), and whitespace and syntax minifying take the gzip size of the 191 JS and
// CSS files from 707 KB to 475 KB (-33%).
//
// What it does and does not do, so a stack trace and the page's own code keep working:
//   - whitespace and syntax, and the names of local variables and functions (#7185: 360 KB of the shipped tree): exported names, property names, string keys and
//     import paths are never renamed, so no behaviour changes (no code here reads a function's name or a stack trace); the console's stack frames name short
//     letters, and CORAL_NO_MINIFY=1 serves the source to read in the browser's devtools; module boundaries and import paths are untouched (no bundling);
//   - comments are dropped, "legal" ones (@license, @preserve) kept; Unicode is left as UTF-8, not escaped;
//   - vendor/, *.min.js and agent_docs are served as they are (already minified or not code).
//
// The result is a pure function of (name, data): the server computes it once per file and caches it (internal/server/static_assets.go),
// and an embedder that serves the same tree (the Cloud Hub) calls this too. CORAL_NO_MINIFY=1 turns it off, to read the source in the
// browser's devtools.
func MinifyAsset(name string, data []byte) []byte {
	if disabled.Load() || os.Getenv("CORAL_NO_MINIFY") == "1" {
		return data
	}
	name = strings.TrimPrefix(path.Clean("/"+name), "/")
	ext := path.Ext(name)
	if (ext != ".js" && ext != ".css") || strings.HasPrefix(name, "vendor/") || strings.HasSuffix(name, ".min.js") || strings.HasPrefix(name, "agent_docs/") {
		return data
	}
	opts := minifyOptions(ext)
	opts.Sourcefile = name
	// Run to the fixed point: a second pass shaves a few bytes off a dozen files and a third never changes any. A file embedded already minified (tools/strip-static, #6208) is then served as the very
	// bytes a source build serves, since the server minifies what it serves whatever the binary holds.
	out := data
	for pass := 0; pass < minifyPasses; pass++ {
		res := api.Transform(string(out), opts)
		if len(res.Errors) > 0 || len(res.Code) == 0 || len(res.Code) >= len(out) {
			break
		}
		out = res.Code
	}
	if ext == ".js" {
		out = collapseTagGaps(out)
	}
	return out
}

// tagGap is the indentation a multi-line template literal keeps before a tag that starts an indented line: ">\n            <". esbuild leaves a template's text as written, and the source's markup
// is indented, so these gaps were about 10 KB of the shipped tree (#10594). HTML reads any run of whitespace as one space, so the gap becomes that one space: the page is laid out as it was.
var tagGap = regexp.MustCompile(`\n[ \t]+<`)

// collapseTagGaps shortens those gaps in the template literals of minified JS. esbuild's minified output has a newline only inside a literal (or a legal comment), so every match is template text.
// A file that writes a <pre> or <textarea> keeps its text as it is: there whitespace shows. The result is a fixed point (a second call changes nothing), as MinifyAsset needs.
func collapseTagGaps(js []byte) []byte {
	if bytes.Contains(js, []byte("<pre")) || bytes.Contains(js, []byte("<textarea")) {
		return js
	}
	return tagGap.ReplaceAll(js, []byte(" <"))
}

// minifyPasses is the most times MinifyAsset runs esbuild over one file (it stops at the first pass that does not shrink it).
const minifyPasses = 3

// minifyOptions are the esbuild options MinifyAsset transforms a file of this extension (".js" or
// ".css") with, except the file's own Sourcefile. The one place they are written: MinifyIdentity is
// built from this value, so an option cannot change without the identity (and the build id that
// hashes it, #4320) changing with it.
func minifyOptions(ext string) api.TransformOptions {
	opts := api.TransformOptions{
		Target:            api.ESNext,
		MinifyWhitespace:  true,
		MinifySyntax:      true,
		Charset:           api.CharsetUTF8,
		LegalComments:     api.LegalCommentsInline,
		LogLevel:          api.LogLevelSilent,
		MinifyIdentifiers: ext != ".css",
	}
	if ext == ".css" {
		opts.Loader = api.LoaderCSS
	} else {
		opts.Loader = api.LoaderJS
	}
	return opts
}

// optionsIdentity is the text a set of options is named by: every field of both, as Go prints them.
func optionsIdentity(js, css api.TransformOptions) string {
	return fmt.Sprintf("js:%+v css:%+v", js, css)
}

// MinifyIdentity names how MinifyAsset turns a file into the bytes it serves: the esbuild version,
// its options (minifyOptions, every field), the bundle's format (bundleFormat) and whether minifying is off (CORAL_NO_MINIFY=1 or SetMinifyDisabled).
// A version that names served bytes hashes it (#4320).
func MinifyIdentity() string {
	if disabled.Load() || os.Getenv("CORAL_NO_MINIFY") == "1" {
		return "minify:off"
	}
	return fmt.Sprintf("minify:esbuild %s %s passes:%d tag-gaps:1 %s", esbuildVersion, optionsIdentity(minifyOptions(".js"), minifyOptions(".css")), minifyPasses, bundleFormat)
}

// esbuildVersion is the esbuild module version this binary is built with: a constant, not read
// from the build info (a test binary on Windows carries no dependency list there, and the identity
// must not depend on how a binary was built). TestEsbuildVersionMatchesGoMod fails when go.mod's
// version moves and this does not, so the minifier identity follows an esbuild bump.
const esbuildVersion = "v0.25.0"

// disabled is for tests that compare served bytes with the embedded source.
var disabled atomic.Bool

// SetMinifyDisabled turns MinifyAsset into the identity (tests only).
func SetMinifyDisabled(off bool) { disabled.Store(off) }
