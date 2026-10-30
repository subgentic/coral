package frontend

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
)

// The embedded static tree goes into every Coral server binary (and the Hub's), so what it holds
// costs every download. A 6.86 MB logo nothing referenced (static/corral.png) shipped in every
// binary until #3854. These checks keep that from coming back.

const (
	// staticBudget is the most the static tree a release ships may hold: its JS and CSS as the server serves them (minified, comments gone; a release embeds exactly those bytes, tools/strip-static, #6208)
	// and every other file as it is, with the agent docs `make` syncs into static/agent_docs. It is 5.49 MB today (the source tree is 8.21 MB: comments and indentation are not shipped), so a comment
	// never moves it and a real asset does. Raise it deliberately, with the reason in the commit, when a real asset needs the room.
	// 5.25 MiB (5,505,024 bytes) since Goal #61's artifact roll-up; the tree has grown into it, so a feature trims as much as it adds (#10594 and #10623 collapsed the indentation inside templates: 18 KB). About 19 KB of room over what ships
	// 5.34 MiB (5,603,328 bytes) since the operator's approval (Oct 28, #10690): 96 KiB more, room for #10019's docs pictures, #10049, #10376 and #10558.
	// 5.41 MiB (5,668,864 bytes) since the operator's approval (Oct 29, #11058's raise): 64 KiB more. The v2.0.6 tree is at 5,592,908 bytes (10,420 free) with the agent search levels UI (the Search chip and the Search access
	// dialog, #11053: about 7 KB) and the phone chat screen in it, and the queued work (the one-row header, the keyboard fix, the Inbox Goals and Artifacts folders, Board history, #11063's model line: 1.5 KB) is more than that room.
	staticBudget = 5<<20 + 416<<10
	// fileBudget is the most one embedded file may hold (the CodeMirror bundle, the largest, is ~1 MB).
	fileBudget = 1536 << 10
)

// unreferencedImages are images nothing in this repository names, kept because something outside it
// may load them by URL (/static/<name>): Coral Hub serves this tree, and the icons are small.
var unreferencedImages = map[string]string{
	"coral_logo.png":       "logo, may be linked by URL from outside the repo (1 KB)",
	"coral_logo.svg":       "logo, may be linked by URL from outside the repo (9 KB)",
	"coral_tray.png":       "tray icon, may be linked by URL from outside the repo (1 KB)",
	"coral-icon-88x88.png": "icon, may be linked by URL from outside the repo (4 KB)",
}

// shippedStaticBytes is what a release's static tree holds: every embedded file as the server serves it (JS and CSS minified), and the agent docs counted once, from the embedded tree when this
// checkout has synced them into static/agent_docs and from docsDir (the source the sync copies) when it has not (#10530). It returns the shipped bytes and the source bytes.
func shippedStaticBytes(fsys fs.FS, docsDir string) (total, source int64, err error) {
	synced := false
	err = fs.WalkDir(fsys, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if strings.HasPrefix(p, "static/agent_docs/") {
			synced = true
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		source += int64(len(data))
		// What a release carries: its JS and CSS are embedded already minified (tools/strip-static, #6208), the bytes the server serves; MinifyAsset is the identity for every other file.
		total += int64(len(MinifyAsset(strings.TrimPrefix(p, "static/"), data)))
		return nil
	})
	if err != nil || synced {
		return total, source, err
	}
	entries, rerr := os.ReadDir(docsDir)
	if rerr != nil {
		return total, source, nil // no docs folder here: nothing to add
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil {
			return total, source, ierr
		}
		total += info.Size()
		source += info.Size()
	}
	return total, source, nil
}

func TestStaticTreeWithinBudget(t *testing.T) {
	var big []string
	_ = fs.WalkDir(Static, "static", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, ierr := d.Info(); ierr == nil && info.Size() > fileBudget {
				big = append(big, fmt.Sprintf("%s is %d bytes, over the %d-byte budget for one embedded file: every Coral binary carries it", p, info.Size(), fileBudget))
			}
		}
		return nil
	})
	for _, m := range big {
		t.Error(m)
	}
	total, source, err := shippedStaticBytes(Static, filepath.Join("..", "..", "agent_docs"))
	if err != nil {
		t.Fatal(err)
	}
	if total > staticBudget {
		t.Errorf("the static tree a release ships is %d bytes, over its %d-byte budget (staticBudget): every Coral binary carries it", total, staticBudget)
	}
	t.Logf("static tree a release ships: %d bytes (budget %d); its source: %d", total, staticBudget, source)
}

func isImage(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".avif", ".bmp":
		return true
	}
	return false
}

// TestStaticImagesAreReferenced fails on an embedded image whose file name appears nowhere in the
// static text files, the templates or the module's Go sources.
func TestStaticImagesAreReferenced(t *testing.T) {
	var images []string
	var corpus strings.Builder
	for _, root := range []struct {
		fsys fs.FS
		dir  string
	}{{Static, "static"}, {Templates, "templates"}} {
		err := fs.WalkDir(root.fsys, root.dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			if isImage(p) {
				if root.dir == "static" {
					images = append(images, p)
				}
				return nil
			}
			b, err := fs.ReadFile(root.fsys, p)
			if err != nil {
				return err
			}
			corpus.Write(b)
			corpus.WriteByte('\n')
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	// The module's Go sources (the server serves some icons by name, e.g. internal/server/static_assets.go).
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(moduleRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || n == "bin" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "static_budget_test.go") {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		corpus.Write(b)
		corpus.WriteByte('\n')
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The Docs pages (coral-go/agent_docs) name their screenshots in static/docs-img (#5038). The copy `make` syncs into static/agent_docs is not in a clean checkout, so the
	// sources are read here.
	docs, err := filepath.Glob(filepath.Join(moduleRoot, "agent_docs", "*.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		b, err := os.ReadFile(d)
		if err != nil {
			t.Fatal(err)
		}
		corpus.Write(b)
		corpus.WriteByte('\n')
	}
	if len(images) == 0 {
		t.Fatal("found no images in the static tree; the walk is wrong")
	}
	text := corpus.String()
	for _, p := range images {
		name := path.Base(p)
		if strings.Contains(text, name) {
			if why, ok := unreferencedImages[name]; ok {
				t.Errorf("%s is referenced now; drop it from unreferencedImages (%s)", p, why)
			}
			continue
		}
		if _, ok := unreferencedImages[name]; ok {
			continue
		}
		t.Errorf("%s is embedded in every Coral binary but nothing names it (static text files, templates, Go sources): delete it, or reference it", p)
	}
	for name := range unreferencedImages {
		if _, err := fs.Stat(Static, "static/"+name); err != nil {
			t.Errorf("unreferencedImages lists %s, which is not in the static tree: drop it", name)
		}
	}
}
