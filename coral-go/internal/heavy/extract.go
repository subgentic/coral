package heavy

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

// Limits are the extractor's own caps: the header of a run may only lower them.
type Limits struct {
	Files int   // regular files
	Bytes int64 // their bytes, in all
}

// Stats is what an extraction wrote.
type Stats struct {
	Files int
	Bytes int64
}

func unsafef(format string, a ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrUnsafe}, a...)...)
}

// cleanName checks an archive path: relative, no "..", no NUL, no backslash, nothing under a .git folder; it returns the cleaned slash path.
func cleanName(name string) (string, error) {
	n := strings.TrimSuffix(name, "/")
	if n == "" || strings.ContainsAny(n, "\x00\\") || strings.HasPrefix(n, "/") {
		return "", unsafef("the name %q", name)
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." || part == "" || part == "." || strings.EqualFold(part, ".git") {
			return "", unsafef("the name %q", name)
		}
	}
	return path.Clean(n), nil
}

// linkTarget checks that a symlink's target is relative and, from where the link sits, stays inside the folder.
func linkTarget(at, target string) error {
	if target == "" || strings.ContainsAny(target, "\x00\\") || strings.HasPrefix(target, "/") {
		return unsafef("the link target %q", target)
	}
	resolved := path.Join(path.Dir(at), target)
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return unsafef("the link %q leaves the folder", at)
	}
	return nil
}

// Extract unpacks a plain (not compressed) tar stream into dir, which must be an empty run folder. It trusts nothing: every path is relative and clean, only regular files, folders and links that stay inside are made, every
// file and folder is made through os.Root (nothing is written through a link), links are made last (so no entry can pass through one), names that differ only by case collide (a macOS volume is case-insensitive), setuid,
// setgid and sticky bits and owners are ignored, modes are 0700 or 0600 by the owner-execute bit, and the file and byte caps stop it.
func Extract(dir string, r io.Reader, lim Limits) (Stats, error) {
	var st Stats
	root, err := os.OpenRoot(dir)
	if err != nil {
		return st, err
	}
	defer root.Close()
	spelled := map[string]string{} // lower-case path -> the spelling first seen, for every file, folder and folder on the way
	claim := func(p string) error {
		parts := strings.Split(p, "/")
		for i := range parts {
			pre := strings.Join(parts[:i+1], "/")
			low := strings.ToLower(pre)
			if was, ok := spelled[low]; ok && was != pre {
				return unsafef("%q and %q are one name on a case-insensitive volume", pre, was)
			}
			spelled[low] = pre
		}
		return nil
	}
	type link struct{ at, target string }
	var links []link
	entries := 0
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return st, err
		}
		switch h.Typeflag {
		case tar.TypeXGlobalHeader:
			continue
		case tar.TypeReg, tar.TypeDir, tar.TypeSymlink:
		default:
			return st, unsafef("entry %q is not a file, folder or link", h.Name)
		}
		name, err := cleanName(h.Name)
		if err != nil {
			return st, err
		}
		if entries++; entries > lim.Files { // every entry counts, not only the regular files: millions of empty folders or links are an archive too
			return st, ErrTooBig
		}
		if err := claim(name); err != nil {
			return st, err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o700); err != nil {
				return st, unsafef("%v", err)
			}
		case tar.TypeSymlink:
			if err := linkTarget(name, h.Linkname); err != nil {
				return st, err
			}
			links = append(links, link{name, h.Linkname})
		case tar.TypeReg:
			if st.Files+1 > lim.Files || st.Bytes+h.Size > lim.Bytes {
				return st, ErrTooBig
			}
			if dir := path.Dir(name); dir != "." {
				if err := root.MkdirAll(dir, 0o700); err != nil {
					return st, unsafef("%v", err)
				}
			}
			mode := os.FileMode(0o600)
			if h.Mode&0o100 != 0 {
				mode = 0o700
			}
			f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return st, unsafef("%v", err)
			}
			n, cerr := io.Copy(f, io.LimitReader(tr, h.Size))
			if err := f.Close(); cerr == nil {
				cerr = err
			}
			if cerr != nil {
				return st, cerr
			}
			if n != h.Size {
				return st, errors.New("heavy: the archive ended inside a file")
			}
			st.Files++
			st.Bytes += n
		}
	}
	for _, l := range links { // after every file and folder: a name already taken is refused
		if dir := path.Dir(l.at); dir != "." {
			if err := root.MkdirAll(dir, 0o700); err != nil {
				return st, unsafef("%v", err)
			}
		}
		if err := root.Symlink(l.target, l.at); err != nil {
			return st, unsafef("the link %q: %v", l.at, err)
		}
	}
	return st, nil
}
