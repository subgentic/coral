package frontend

import (
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/gob"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
)

// A prebuilt bundled family (#8760). BuildBundle is a pure function of the embedded static tree and the shell template, and it is the largest work a server does at start: about
// 1.5 CPU seconds and a heap that peaks at 230 to 330 MB. A release build runs it once, at build time (tools/strip-static, on the minified tree the binary will embed), and embeds the
// result as prebuilt/bundle.gob.gz through the build overlay; the server then reads it back instead of building. A dev build has no such file and builds at start, as before.
//
// The file carries the hash of what it was built from (BundleInputHash). The server uses it only when the hash of the tree it is actually serving is the same: a file that does not match
// (a build whose steps ran in another order, a stale file) is ignored and the family is built, so what is served is always the build of what is embedded.

//go:embed all:prebuilt
var prebuiltFS embed.FS

// PrebuiltDir and PrebuiltName name the embedded file: pkg/frontend/prebuilt/bundle.gob.gz.
const (
	PrebuiltDir  = "prebuilt"
	PrebuiltName = "bundle.gob.gz"
)

// prebuiltReader opens the embedded file; a variable so a test can give another.
var prebuiltReader = func() (io.ReadCloser, error) { return prebuiltFS.Open(PrebuiltDir + "/" + PrebuiltName) }

// BundleInputHash names what BuildBundle's output is a function of: the format of the family (bundleFormat), the shell template and every JavaScript and CSS file of the static tree
// (path and bytes, in path order). Other files (images, fonts, JSON) are never read by the build.
func BundleInputHash(static fs.FS, indexHTML []byte) (string, error) {
	var names []string
	err := fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && (strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css")) {
			names = append(names, p)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(names)
	h := sha256.New()
	field := func(b []byte) { fmt.Fprintf(h, "%d:", len(b)); h.Write(b) }
	field([]byte(bundleFormat))
	field(indexHTML)
	for _, n := range names {
		data, err := fs.ReadFile(static, path.Clean(n))
		if err != nil {
			return "", err
		}
		field([]byte(n))
		field(data)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

type prebuiltFile struct {
	Hash    string
	Sum     string // SHA-256 of the files (names and bytes, in name order): what the file says its content is, checked after the decode
	Files   map[string][]byte
	Modules []string
	Lazy    []string
	Skipped map[string]string // LazySkipped's errors as text
}

// EncodePrebuilt writes b, built from the tree whose BundleInputHash is hash, as the embedded file's bytes (gob, gzip).
func EncodePrebuilt(w io.Writer, b *Bundle, hash string) error {
	pf := prebuiltFile{Hash: hash, Sum: filesSum(b.Files), Files: b.Files, Modules: b.Modules, Lazy: b.Lazy, Skipped: map[string]string{}}
	for k, v := range b.LazySkipped {
		pf.Skipped[k] = v.Error()
	}
	zw, err := gzip.NewWriterLevel(w, gzip.BestCompression)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(zw).Encode(&pf); err != nil {
		return err
	}
	return zw.Close()
}

// DecodePrebuilt reads what EncodePrebuilt wrote, with the hash of the tree it was built from.
func DecodePrebuilt(r io.Reader) (*Bundle, string, error) {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return nil, "", err
	}
	defer zr.Close()
	var pf prebuiltFile
	if err := gob.NewDecoder(zr).Decode(&pf); err != nil {
		return nil, "", err
	}
	// Read the stream to its end: that is where gzip checks its CRC and length. A gob string takes any bytes, so a bit flipped in the compressed data decodes to different file content
	// unless something checks it (a flipped bit was accepted 213 times in 400, #8785), and the content is also compared with the sum the file carries.
	if _, err := io.Copy(io.Discard, zr); err != nil {
		return nil, "", err
	}
	if pf.Sum == "" || pf.Sum != filesSum(pf.Files) {
		return nil, "", errors.New("the prebuilt bundle does not match its own checksum")
	}
	if pf.Hash == "" || len(pf.Files["app.js"]) == 0 {
		return nil, "", errors.New("the prebuilt bundle has no hash or no app.js")
	}
	b := &Bundle{Files: pf.Files, Modules: pf.Modules, Lazy: pf.Lazy, LazySkipped: map[string]error{}}
	for k, v := range pf.Skipped {
		b.LazySkipped[k] = errors.New(v)
	}
	return b, pf.Hash, nil
}

// PrebuiltOrBuild is BuildBundle for a server: the embedded prebuilt family when there is one and it was built from the tree being served, else a fresh build. how says which ("prebuilt",
// "built", or "built" with why the prebuilt file was not used), for the start-up log. The family it returns is the same files either way (TestPrebuiltIsTheBuild).
func PrebuiltOrBuild(static fs.FS, indexHTML []byte) (b *Bundle, how string, err error) {
	how = "built"
	if f, openErr := prebuiltReader(); openErr == nil {
		pre, hash, decErr := DecodePrebuilt(f)
		f.Close()
		switch {
		case decErr != nil:
			how = "built (the prebuilt file is not readable: " + decErr.Error() + ")"
		default:
			want, hashErr := BundleInputHash(static, indexHTML)
			switch {
			case hashErr != nil:
				how = "built (" + hashErr.Error() + ")"
			case want != hash:
				how = "built (the prebuilt file is of another tree)"
			default:
				return pre, "prebuilt", nil
			}
		}
	}
	b, err = BuildBundle(static, indexHTML)
	return b, how, err
}

// filesSum is the SHA-256 of files, each name and its bytes with their lengths, in name order.
func filesSum(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		fmt.Fprintf(h, "%d:%s%d:", len(n), n, len(files[n]))
		h.Write(files[n])
	}
	return hex.EncodeToString(h.Sum(nil))
}
