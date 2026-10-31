//go:build !windows

package routes

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// The native installer's places (#11454, Security's ruling): the installer of a CLI puts ~/.local/bin/<cli> as a link to ~/.local/share/<cli>/versions/<version> and its updater rewrites that link. They are
// the one thing under the home folder that is exempt from an agent whose working folder IS the home folder (or a folder above it); nothing else under home is, and an agent working in ~/.local,
// ~/.local/bin or inside the share folder (below home) is still refused. What the exemption does NOT do is stop an agent from replacing the binary: an agent runs as the same user and owns the file;
// the checks below keep out a link to somewhere else, a file somebody else owns or can write, and a folder others can write to.

// nativeInstallerPlace says p (a typed path or what it resolves to) is the native installer's place of one of the known CLIs and is safe to run from: ~/.local/bin/<cli> whose real target is a
// regular file under ~/.local/share/<cli>/versions/, or that target itself, owned by the current user, not writable by group or others, in folders others cannot write to.
func nativeInstallerPlace(p string, known map[string]bool) bool {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return false
	}
	// Everything is compared on RESOLVED folders (macOS temp and home folders are reached through links): the home folder's real path, the typed path's folder resolved and its file name kept.
	rhome := realOrSelf(filepath.Clean(home))
	p = filepath.Clean(p)
	typed := filepath.Join(realOrSelf(filepath.Dir(p)), filepath.Base(p))
	for cli := range known {
		bin := filepath.Join(rhome, ".local", "bin", cli)
		share := filepath.Join(rhome, ".local", "share", cli)
		versions := filepath.Join(share, "versions")
		// Every folder on the way to the installer's files is the user's and not writable by others, not only the two that hold them: anyone who could write ~/.local, ~/.local/share or the CLI's
		// own share folder could swap the folder under the file (Security's SHOULD, #11467).
		parentsPrivate := func() bool {
			for _, d := range []string{filepath.Join(rhome, ".local"), filepath.Join(rhome, ".local", "share"), share} {
				if !privateDir(d) {
					return false
				}
			}
			return true
		}
		switch {
		case typed == bin:
			real := filepath.Clean(realOrSelf(typed))
			if !underDir(versions, real) {
				return false // a link to anywhere else is not the installer's
			}
			return parentsPrivate() && privateRegular(real) && privateDir(filepath.Dir(typed)) && privateDir(filepath.Dir(real)) && ownedNotWritable(typed)
		case underDir(versions, typed):
			if filepath.Clean(realOrSelf(typed)) != typed { // a link inside the versions folder to somewhere else is not the installer's file
				return false
			}
			return parentsPrivate() && privateRegular(typed) && privateDir(filepath.Dir(typed))
		}
	}
	return false
}

// underDir reports whether p is a path below dir (never dir itself).
func underDir(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func fileOwnedByMe(st os.FileInfo) bool {
	s, ok := st.Sys().(*syscall.Stat_t)
	return ok && int(s.Uid) == os.Getuid()
}

// privateRegularInfo: a regular file owned by the current user, not writable by group or others. (On the FileInfo, so a test can give it another owner.)
func privateRegularInfo(st os.FileInfo) bool {
	return st.Mode().IsRegular() && fileOwnedByMe(st) && st.Mode().Perm()&0o022 == 0
}

// privateDirInfo: a folder owned by the current user that group and others cannot write to.
func privateDirInfo(st os.FileInfo) bool {
	return st.IsDir() && fileOwnedByMe(st) && st.Mode().Perm()&0o022 == 0
}

// privateRegular: privateRegularInfo of the file the path leads to (after links).
func privateRegular(p string) bool {
	st, err := os.Stat(p)
	return err == nil && privateRegularInfo(st)
}

// privateDir: privateDirInfo of the folder the path leads to.
func privateDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && privateDirInfo(st)
}

// ownedNotWritable: the link itself is the current user's (a link's own mode bits mean nothing on Linux).
func ownedNotWritable(p string) bool {
	st, err := os.Lstat(p)
	return err == nil && fileOwnedByMe(st)
}
