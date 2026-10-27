package frontend

import (
	"bytes"
	"io"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func prebuiltOf(t *testing.T, static fs.FS, index []byte) ([]byte, *Bundle, string) {
	t.Helper()
	b, err := BuildBundle(static, index)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := BundleInputHash(static, index)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := EncodePrebuilt(&buf, b, hash); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), b, hash
}

func withPrebuilt(t *testing.T, data []byte) {
	t.Helper()
	real := prebuiltReader
	t.Cleanup(func() { prebuiltReader = real })
	prebuiltReader = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil }
}

// The prebuilt family is the build of the tree: every file, byte for byte, the startup modules, the lazy modules and what was skipped (#8760).
func TestPrebuiltIsTheBuild(t *testing.T) {
	built, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	data, _, _ := prebuiltOf(t, static, index)
	withPrebuilt(t, data)
	got, how, err := PrebuiltOrBuild(static, index)
	if err != nil || how != "prebuilt" {
		t.Fatalf("how %q, err %v: the matching prebuilt file was not used", how, err)
	}
	if len(got.Files) != len(built.Files) {
		t.Fatalf("%d files, the build has %d", len(got.Files), len(built.Files))
	}
	for name, want := range built.Files {
		if !bytes.Equal(got.Files[name], want) {
			t.Errorf("%s differs from the build", name)
		}
	}
	if strings.Join(got.Modules, ",") != strings.Join(built.Modules, ",") || strings.Join(got.Lazy, ",") != strings.Join(built.Lazy, ",") {
		t.Error("the module lists differ from the build's")
	}
	if len(got.LazySkipped) != len(built.LazySkipped) {
		t.Errorf("skipped %v, the build skipped %v", got.LazySkipped, built.LazySkipped)
	}
	if len(got.Files) < 500 || len(got.Lazy) < 100 {
		t.Errorf("%d files and %d lazy modules: the comparison proves little", len(got.Files), len(got.Lazy))
	}
}

// A prebuilt file of another tree is not used: it names what it was built from, and a server serving something else builds its own (#8760).
func TestPrebuiltOfAnotherTreeIsIgnored(t *testing.T) {
	_, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	data, _, hash := prebuiltOf(t, static, index)
	withPrebuilt(t, data)

	// one byte of one module, the template, and the format are each part of the name
	changed := fstest.MapFS{}
	_ = fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		b, _ := fs.ReadFile(static, p)
		if p == "sidebar_groups.js" {
			b = append(append([]byte{}, b...), []byte("\n// one more byte\n")...)
		}
		changed[p] = &fstest.MapFile{Data: b}
		return nil
	})
	b, how, err := PrebuiltOrBuild(changed, index)
	if err != nil || !strings.HasPrefix(how, "built (the prebuilt file is of another tree") {
		t.Fatalf("how %q, err %v: a prebuilt file of another tree was used", how, err)
	}
	if !bytes.Contains(b.Files["app.js"], []byte("one more byte")) && len(b.Files["app.js"]) == 0 {
		t.Error("the fresh build is empty")
	}
	if h2, _ := BundleInputHash(static, append([]byte("<!-- -->"), index...)); h2 == hash {
		t.Error("the shell template is not part of the hash")
	}
	// a file that is not JavaScript or CSS is never read by the build and is not part of the hash
	extra := fstest.MapFS{}
	_ = fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(static, p)
			extra[p] = &fstest.MapFile{Data: b}
		}
		return nil
	})
	extra["favicon-new.png"] = &fstest.MapFile{Data: []byte("png")}
	if h3, _ := BundleInputHash(extra, index); h3 != hash {
		t.Error("an image changed the hash")
	}
}

// A file that is not readable (corrupt, empty) is ignored too, and the family is built: the server never fails to start for it.
func TestUnreadablePrebuiltIsIgnored(t *testing.T) {
	_, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	for name, data := range map[string][]byte{"empty": nil, "garbage": []byte("not gzip"), "truncated": func() []byte { d, _, _ := prebuiltOf(t, static, index); return d[:len(d)/2] }()} {
		withPrebuilt(t, data)
		b, how, err := PrebuiltOrBuild(static, index)
		if err != nil || !strings.HasPrefix(how, "built (the prebuilt file is not readable") || len(b.Files["app.js"]) == 0 {
			t.Errorf("%s: how %q, err %v", name, how, err)
		}
	}
}

// With no prebuilt file (a source tree: the folder holds only its README) the family is built.
func TestNoPrebuiltBuilds(t *testing.T) {
	_, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	b, how, err := PrebuiltOrBuild(static, index)
	if err != nil || how != "built" || len(b.Files["app.js"]) == 0 {
		t.Errorf("how %q, err %v", how, err)
	}
	if _, err := prebuiltFS.ReadFile(PrebuiltDir + "/README"); err != nil {
		t.Errorf("the prebuilt folder has lost its README, so go:embed has nothing to embed in a source tree: %v", err)
	}
}

// sameBundle says two decoded prebuilt families are the same: every file byte for byte, the module lists, and what was skipped.
func sameBundle(a, b *Bundle) bool {
	if len(a.Files) != len(b.Files) || strings.Join(a.Modules, ",") != strings.Join(b.Modules, ",") || strings.Join(a.Lazy, ",") != strings.Join(b.Lazy, ",") || len(a.LazySkipped) != len(b.LazySkipped) {
		return false
	}
	for name, want := range a.Files {
		got, ok := b.Files[name]
		if !ok || !bytes.Equal(got, want) {
			return false
		}
	}
	for name, e := range a.LazySkipped {
		if f, ok := b.LazySkipped[name]; !ok || f.Error() != e.Error() {
			return false
		}
	}
	return true
}

// A damaged prebuilt file never changes what is served (#8760, #8785, #8993): a flipped bit is either refused or leaves exactly the intact family. gzip's header is ten bytes and its CRC
// covers only the data, so a flip in the header's time, extra-flags or OS byte decodes to the same files; that is harmless, and which of 100 seeded offsets lands there depends on the file's
// length (run 138 failed on it). What must never happen is a file that decodes without an error to different files.
func TestAFlippedBitInThePrebuiltFileNeverChangesWhatIsServed(t *testing.T) {
	_, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	data, _, _ := prebuiltOf(t, static, index)
	ref, refHash, err := DecodePrebuilt(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("the intact file is refused: %v", err)
	}
	seed := uint64(8785)
	next := func() uint64 { seed = seed*6364136223846793005 + 1442695040888963407; return seed >> 33 }
	refused, same := 0, 0
	for i := 0; i < 100; i++ {
		damaged := append([]byte{}, data...)
		damaged[int(next())%len(damaged)] ^= 1 << (next() % 8)
		b, hash, err := DecodePrebuilt(bytes.NewReader(damaged))
		switch {
		case err != nil:
			refused++
		case hash == refHash && sameBundle(b, ref):
			same++ // a bit of the header that nothing reads: the same family
		default:
			t.Errorf("flip %d: a damaged file decoded without an error to different content", i)
		}
	}
	if refused < 90 {
		t.Errorf("only %d of 100 damaged files were refused (%d decoded to the same family): the checks are not reading the data", refused, same)
	}
	// a file cut short, or with a trailing byte changed, is refused too
	if _, _, err := DecodePrebuilt(bytes.NewReader(data[:len(data)-4])); err == nil {
		t.Error("a file with its gzip trailer cut was accepted")
	}
}

// The ten bytes of gzip's header: the first four (two ids, the method, the flags) decide how the rest is read, so a flip there is refused or leaves the same family; the next six (the modification
// time, the extra flags and the operating system) are read by nothing, so a flip in any of them leaves exactly the same family, with no error (#8993).
func TestEveryBitOfTheGzipHeaderEitherChangesNothingOrIsRefused(t *testing.T) {
	_, static := realBundle(t)
	index, _ := fs.ReadFile(Templates, "templates/index.html")
	data, _, _ := prebuiltOf(t, static, index)
	ref, refHash, err := DecodePrebuilt(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("the intact file is refused: %v", err)
	}
	for off := 0; off < 10; off++ {
		for bit := 0; bit < 8; bit++ {
			damaged := append([]byte{}, data...)
			damaged[off] ^= 1 << bit
			b, hash, err := DecodePrebuilt(bytes.NewReader(damaged))
			identical := err == nil && hash == refHash && sameBundle(b, ref)
			switch {
			case off >= 4 && !identical:
				t.Errorf("header byte %d bit %d: nothing reads it, so the family must decode unchanged (err %v)", off, bit, err)
			case off < 4 && err == nil && !identical:
				t.Errorf("header byte %d bit %d: decoded without an error to different content", off, bit)
			}
		}
	}
}
