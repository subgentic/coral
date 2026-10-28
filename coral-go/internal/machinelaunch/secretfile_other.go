//go:build !unix

package machinelaunch

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// ReadSecretFile reads one secret from path, or from stdin when path is "-". Windows has no mode bits to check (access is by ACL, which this does not read): the file must be a regular file of at
// most 4096 bytes, and keeping it private to the person is theirs to do. The returned text has its surrounding white space trimmed; errors never hold the contents.
func ReadSecretFile(path string, stdin io.Reader) (string, error) {
	var r io.Reader
	if path == "-" {
		if stdin == nil {
			return "", fmt.Errorf("%w: no standard input", ErrUnsafeSecretFile)
		}
		r = stdin
	} else {
		st, err := os.Lstat(path)
		if err != nil {
			return "", fmt.Errorf("%s: no such file", path)
		}
		if !st.Mode().IsRegular() {
			return "", fmt.Errorf("%w: %s is not a regular file", ErrUnsafeSecretFile, path)
		}
		f, err := os.Open(path)
		if err != nil {
			return "", fmt.Errorf("%w: %s cannot be opened", ErrUnsafeSecretFile, path)
		}
		defer f.Close()
		r = f
	}
	b, err := io.ReadAll(io.LimitReader(r, maxSecretFile+1))
	if err != nil {
		return "", fmt.Errorf("%w: it could not be read", ErrUnsafeSecretFile)
	}
	if len(b) > maxSecretFile {
		return "", fmt.Errorf("%w: it is larger than %d bytes", ErrUnsafeSecretFile, maxSecretFile)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", ErrEmptySecret
	}
	return s, nil
}
