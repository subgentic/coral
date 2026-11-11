// Package push carries a release this computer verified to a Coral that has no internet, over the operator's own ssh (#15379).
//
// The wire format is a fixed stream of named files, never tar: nothing in it is a path, a link or an option for the receiver to interpret.
//
//	coral-push 1\n
//	file <name> <decimal length>\n<exactly length bytes>      (once for each of the six names, in any order)
//	end\n
//
// The sender's checks are not the trust: the receiver's own `coral-update apply` verifies everything again with its compiled-in pins.
package push

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const (
	magic = "coral-push 1"
	// maxHeader bounds a header line: a name is at most ~60 bytes and a length 10 digits.
	maxHeader = 200
	// MaxSmall bounds every file but the package (a manifest, a sums file, a bundle, the record).
	MaxSmall = 1 << 20
)

// File is one named file of the stream.
type File struct {
	Name string
	Size int64
	Open func() (io.ReadCloser, error)
}

// Names are the six names the stream may carry, in the order the sender writes them; the package's name is the platform's asset.
func Names(asset string) []string {
	return []string{"promote.json", "promote.json.sigstore.json", "SHA256SUMS.txt", "SHA256SUMS.txt.sigstore.json", "record.json", asset}
}

// Write writes the stream for files (exactly the six names, each once).
func Write(w io.Writer, asset string, files []File) error {
	want := map[string]bool{}
	for _, n := range Names(asset) {
		want[n] = true
	}
	if len(files) != len(want) {
		return errors.New("push: the stream carries exactly six files")
	}
	if _, err := io.WriteString(w, magic+"\n"); err != nil {
		return err
	}
	for _, f := range files {
		if !want[f.Name] {
			return fmt.Errorf("push: %q is not a file of the stream", f.Name)
		}
		delete(want, f.Name)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "file %s %d\n", f.Name, f.Size); err != nil {
			rc.Close()
			return err
		}
		n, err := io.Copy(w, io.LimitReader(rc, f.Size))
		rc.Close()
		if err != nil {
			return err
		}
		if n != f.Size {
			return fmt.Errorf("push: %s is shorter than its size", f.Name)
		}
	}
	_, err := io.WriteString(w, "end\n")
	return err
}

func readLine(br *bufio.Reader) (string, error) {
	var b []byte
	for {
		c, err := br.ReadByte()
		if err != nil {
			return "", err
		}
		if c == '\n' {
			return string(b), nil
		}
		if len(b) >= maxHeader {
			return "", errors.New("header line too long")
		}
		b = append(b, c)
	}
}

// Reader reads the stream. Next returns each file's name and a reader limited to its length; the caller must read it to the end before the next call.
type Reader struct {
	br    *bufio.Reader
	want  map[string]bool
	seen  int
	max   func(name string) int64
	asset string
	began bool
	done  bool
	cur   *io.LimitedReader
}

// NewReader reads a stream for asset; maxPackage caps the package, MaxSmall every other file.
func NewReader(r io.Reader, asset string, maxPackage int64) *Reader {
	want := map[string]bool{}
	for _, n := range Names(asset) {
		want[n] = true
	}
	return &Reader{br: bufio.NewReader(r), want: want, asset: asset, max: func(n string) int64 {
		if n == asset {
			return maxPackage
		}
		return MaxSmall
	}}
}

// Next returns io.EOF after a complete, well-formed stream (all six names seen, then "end").
func (r *Reader) Next() (string, io.Reader, error) {
	if r.cur != nil && r.cur.N != 0 {
		return "", nil, errors.New("push: the previous file was not read to its end")
	}
	if r.done {
		return "", nil, io.EOF
	}
	if !r.began {
		l, err := readLine(r.br)
		if err != nil || l != magic {
			return "", nil, errors.New("push: not a coral-push stream")
		}
		r.began = true
	}
	l, err := readLine(r.br)
	if err != nil {
		return "", nil, errors.New("push: the stream ended early")
	}
	if l == "end" {
		if len(r.want) != 0 {
			return "", nil, errors.New("push: the stream is missing a file")
		}
		r.done = true
		if _, err := r.br.ReadByte(); err != io.EOF {
			return "", nil, errors.New("push: bytes after the end")
		}
		return "", nil, io.EOF
	}
	f := strings.Split(l, " ")
	if len(f) != 3 || f[0] != "file" || !r.want[f[1]] {
		return "", nil, errors.New("push: an unexpected file in the stream")
	}
	if len(f[2]) == 0 || len(f[2]) > 10 || f[2][0] == '+' || f[2][0] == '-' {
		return "", nil, errors.New("push: a bad length")
	}
	n, err := strconv.ParseInt(f[2], 10, 64)
	if err != nil || n < 0 || n > r.max(f[1]) {
		return "", nil, errors.New("push: a file is larger than allowed")
	}
	delete(r.want, f[1])
	r.cur = &io.LimitedReader{R: r.br, N: n}
	return f[1], r.cur, nil
}
