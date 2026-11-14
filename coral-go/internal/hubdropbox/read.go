// Package hubdropbox is Coral's half of "Dropbox connected once on the Hub" (#16012 contract r2, #16109): the one read of a file (SHA-256, secret scan and Dropbox content_hash from the same bytes)
// and the upload client for a one-time link the Hub hands out. It is dark: nothing calls it until the owner-only setting is on. The link is a bearer secret and never leaves the
// memory of one upload: not a log line, not an error, not argv.
package hubdropbox

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"

	"github.com/subgentic/coral/pkg/redact"
)

// MaxFile is the artifact cap (maxAgentArtifactSize): a bigger file is refused, never cut.
const MaxFile = 64 << 20

// blockSize is the size of one block of Dropbox's content_hash.
const blockSize = 4 << 20

// ErrTooBig is returned when a file is over MaxFile.
var ErrTooBig = errors.New("file is over the 64 MiB limit")

// File is what one read of a file gives. Data is exactly what was hashed and scanned, and what Upload sends.
type File struct {
	Data        []byte
	Size        int64
	Digest      string // hex SHA-256 of Data: the artifact id
	ContentHash string // Dropbox content_hash of Data, 64 lowercase hex
	// Flagged is true when the secret scanner would change the bytes. A file that could not be scanned counts as flagged: it is held for the owner's "Upload anyway", never sent.
	Flagged bool
}

// ReadOnce reads r once, to the end, and computes everything from those bytes. It never rereads.
func ReadOnce(r io.Reader) (*File, error) {
	lr := io.LimitReader(r, MaxFile+1)
	var buf bytes.Buffer
	whole := sha256.New()
	blocks := sha256.New() // sha256 over the concatenated sha256 of each block
	blk := sha256.New()
	inBlk := 0
	chunk := make([]byte, 64<<10)
	for {
		n, err := lr.Read(chunk)
		if n > 0 {
			p := chunk[:n]
			if int64(buf.Len()+n) > MaxFile {
				return nil, ErrTooBig
			}
			buf.Write(p)
			whole.Write(p)
			for len(p) > 0 {
				take := blockSize - inBlk
				if take > len(p) {
					take = len(p)
				}
				blk.Write(p[:take])
				inBlk += take
				p = p[take:]
				if inBlk == blockSize {
					blocks.Write(blk.Sum(nil))
					blk.Reset()
					inBlk = 0
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("could not read the file")
		}
	}
	if inBlk > 0 {
		blocks.Write(blk.Sum(nil))
	}
	data := buf.Bytes()
	return &File{
		Data:        data,
		Size:        int64(len(data)),
		Digest:      hex.EncodeToString(whole.Sum(nil)),
		ContentHash: hex.EncodeToString(blocks.Sum(nil)),
		Flagged:     flagged(data),
	}, nil
}

// Scan is the secret scanner: the text it returns differs from its input when it would change something. The default knows token formats only; the server sets it to Coral's full redactor (keyword rules too),
// the one Share via Dropbox already uses, so both paths flag the same files. An error counts as flagged.
var Scan = func(b []byte) ([]byte, error) { return redact.Tokens(b), nil }

// flagged runs the redactor over the bytes. Any panic or doubt is "flagged": a scan that did not finish is never "clean".
func flagged(data []byte) (f bool) {
	defer func() {
		if recover() != nil {
			f = true
		}
	}()
	out, err := Scan(data)
	return err != nil || !bytes.Equal(out, data)
}
