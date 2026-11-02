//go:build unix

package machinelaunch

import (
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
)

// ReadSecretFile reads one secret (a provider token, a Coral Hub key) from path, or from stdin when path is "-". A file is refused unless it is a regular file, not reached through a symlink, owned by the
// person running the command, readable by nobody else (mode 0600 or 0400) and no larger than 4096 bytes. The returned text has its surrounding white space trimmed. Errors name the problem and the path,
// never the contents.
func ReadSecretFile(path string, stdin io.Reader) (string, error) {
	if path == "-" {
		if stdin == nil {
			return "", fmt.Errorf("%w: no standard input", ErrUnsafeSecretFile)
		}
		return finishSecret(io.LimitReader(stdin, maxSecretFile+1))
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%s: no such file", path)
		}
		return "", fmt.Errorf("%w: %s cannot be opened (a symlink is not read)", ErrUnsafeSecretFile, path)
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", fmt.Errorf("%w: %s cannot be checked", ErrUnsafeSecretFile, path)
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	switch {
	case !st.Mode().IsRegular():
		return "", fmt.Errorf("%w: %s is not a regular file", ErrUnsafeSecretFile, path)
	case !ok || int(sys.Uid) != os.Geteuid():
		return "", fmt.Errorf("%w: %s must belong to you", ErrUnsafeSecretFile, path)
	case st.Mode().Perm()&0o077 != 0:
		return "", fmt.Errorf("%w: %s is readable by others: run chmod 600 on it", ErrUnsafeSecretFile, path)
	case sys.Nlink != 1:
		return "", fmt.Errorf("%w: %s has more than one link", ErrUnsafeSecretFile, path)
	case st.Size() > maxSecretFile:
		return "", fmt.Errorf("%w: %s is larger than %d bytes", ErrUnsafeSecretFile, path, maxSecretFile)
	}
	return finishSecret(io.LimitReader(f, maxSecretFile+1))
}

func finishSecret(r io.Reader) (string, error) {
	b, err := io.ReadAll(r)
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
