package push

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/updater/verify"
)

const testAsset = "coral-linux-amd64-1.2.3.tar.gz"

func mkFiles(t *testing.T, version string, pkg []byte, mutate func(*verify.Record)) []File {
	t.Helper()
	sum := sha256.Sum256(pkg)
	rec := verify.Record{Version: version, Asset: testAsset, PackageSHA256: hex.EncodeToString(sum[:])}
	if mutate != nil {
		mutate(&rec)
	}
	rb, _ := json.Marshal(rec)
	data := map[string][]byte{"promote.json": []byte("m"), "promote.json.sigstore.json": []byte("mb"), "SHA256SUMS.txt": []byte("s"), "SHA256SUMS.txt.sigstore.json": []byte("sb"), "record.json": rb, testAsset: pkg}
	var out []File
	for _, n := range Names(testAsset) {
		b := data[n]
		out = append(out, File{Name: n, Size: int64(len(b)), Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }})
	}
	return out
}

func stream(t *testing.T, files []File) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := Write(&b, testAsset, files); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestReceiveRoundTrip(t *testing.T) {
	root := filepath.Join(t.TempDir(), "staging")
	os.MkdirAll(root, 0o700)
	os.MkdirAll(filepath.Join(root, "0.9.9"), 0o700) // an older staged version goes away
	if err := Receive(bytes.NewReader(stream(t, mkFiles(t, "1.2.3", []byte("package"), nil))), root, "1.2.3", testAsset, 1<<20); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "1.2.3", testAsset))
	if err != nil || string(got) != "package" {
		t.Fatalf("package: %q %v", got, err)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != "1.2.3" {
		t.Fatalf("staging holds %v", entries)
	}
	if fi, _ := os.Stat(filepath.Join(root, "1.2.3", testAsset)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
}

func recv(t *testing.T, b []byte, version string) (string, error) {
	root := filepath.Join(t.TempDir(), "staging")
	err := Receive(bytes.NewReader(b), root, version, testAsset, 1<<20)
	if _, serr := os.Stat(filepath.Join(root, "."+version+".partial")); serr == nil {
		t.Fatalf("a partial folder was left behind")
	}
	if err != nil {
		if _, serr := os.Stat(filepath.Join(root, version)); serr == nil {
			t.Fatalf("a refused stream left a staged version")
		}
	}
	return root, err
}

func TestReceiveRefuses(t *testing.T) {
	good := stream(t, mkFiles(t, "1.2.3", []byte("package"), nil))
	cases := map[string]struct {
		b       []byte
		version string
	}{
		"prerelease version":     {good, "1.2.3-rc1"},
		"path as version":        {good, "../1.2.3"},
		"empty":                  {nil, "1.2.3"},
		"no magic":               {[]byte("tar\n"), "1.2.3"},
		"truncated":              {good[:len(good)-30], "1.2.3"},
		"bytes after end":        {append(append([]byte{}, good...), 'x'), "1.2.3"},
		"unknown name":           {bytes.Replace(good, []byte("file record.json"), []byte("file ../record.js"), 1), "1.2.3"},
		"huge length":            {bytes.Replace(good, []byte("file SHA256SUMS.txt 1\n"), []byte("file SHA256SUMS.txt 9999999999\n"), 1), "1.2.3"},
		"signed length":          {bytes.Replace(good, []byte("file SHA256SUMS.txt 1\n"), []byte("file SHA256SUMS.txt +1\n"), 1), "1.2.3"},
		"damaged package":        {stream(t, mkFiles(t, "1.2.3", []byte("package"), func(r *verify.Record) { r.PackageSHA256 = strings.Repeat("0", 64) })), "1.2.3"},
		"record other version":   {stream(t, mkFiles(t, "1.2.4", []byte("package"), nil)), "1.2.3"},
		"record other asset":     {stream(t, mkFiles(t, "1.2.3", []byte("package"), func(r *verify.Record) { r.Asset = "coral-linux-arm64-1.2.3.tar.gz" })), "1.2.3"},
		"a name sent twice":      {bytes.Replace(good, []byte("file record.json"), []byte("file SHA256SUMS.txt"), 1), "1.2.3"},
		"missing a file (end)":   {[]byte("coral-push 1\nend\n"), "1.2.3"},
		"header with no newline": {append([]byte("coral-push 1\nfile "), bytes.Repeat([]byte("a"), 500)...), "1.2.3"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := recv(t, c.b, c.version); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestReceiveRefusesLinkedPartial(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "staging")
	os.MkdirAll(root, 0o700)
	victim := filepath.Join(dir, "victim")
	os.MkdirAll(victim, 0o700)
	os.WriteFile(filepath.Join(victim, "keep"), []byte("x"), 0o600)
	if err := os.Symlink(victim, filepath.Join(root, ".1.2.3.partial")); err != nil {
		t.Skip("no symlinks")
	}
	err := Receive(bytes.NewReader(stream(t, mkFiles(t, "1.2.3", []byte("p"), nil))), root, "1.2.3", testAsset, 1<<20)
	if err == nil {
		t.Fatal("accepted a linked partial folder")
	}
	if _, serr := os.Stat(filepath.Join(victim, "keep")); serr != nil {
		t.Fatal("the link's target was touched")
	}
}

func TestReceiveReplacesStalePartial(t *testing.T) {
	root := filepath.Join(t.TempDir(), "staging")
	stale := filepath.Join(root, ".1.2.3.partial")
	os.MkdirAll(stale, 0o700)
	os.WriteFile(filepath.Join(stale, "promote.json"), []byte("old"), 0o600) // an interrupted push: O_EXCL would otherwise refuse
	if err := Receive(bytes.NewReader(stream(t, mkFiles(t, "1.2.3", []byte("p"), nil))), root, "1.2.3", testAsset, 1<<20); err != nil {
		t.Fatal(err)
	}
}

func TestWriteRefusesWrongNames(t *testing.T) {
	f := mkFiles(t, "1.2.3", []byte("p"), nil)
	f[0].Name = "../x"
	if err := Write(io.Discard, testAsset, f); err == nil {
		t.Fatal("wrote a bad name")
	}
	if err := Write(io.Discard, testAsset, f[:5]); err == nil {
		t.Fatal("wrote five files")
	}
	_ = fmt.Sprint()
}
