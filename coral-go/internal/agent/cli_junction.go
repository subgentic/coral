package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A CLI whose standard path goes through a chain of junctions that Windows refuses to follow (an untrusted mount point, ERROR_UNTRUSTED_MOUNT_POINT): Codex's standalone
// installer gives %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe, where bin is a junction to ~\.codex\packages\standalone\current\bin and current a junction to
// releases\<version>. Where Windows will not open that path, the person had no way on (#582: Settings refused it, and they did not know where the real folder is), so Coral
// follows the chain itself, one link at a time, to the real program, and runs that. It does so again at each use and never saves the versioned path, so an update of the CLI
// (a new releases\<version>, current pointed at it) is followed. A path Windows opens is used as it is: nothing here runs unless Windows refused it. A chain is followed only
// while it stays in the person's own folders or Program Files (junctionRoots), and the program it leads to is screened as any CLI path is before a launch runs it.

// maxJunctionHops bounds the links followed for one path (Codex's chain is two).
const maxJunctionHops = 8

// The file system calls, variables so a test stands in for a Windows that refuses the chain.
var (
	statCLI     = os.Stat
	lstatCLI    = os.Lstat
	readlinkCLI = os.Readlink
)

// RealCLIPath is the path to run for the CLI at p. When Windows opens p (or refuses it for any other reason than an untrusted mount point) it is p itself, with the
// error os.Stat gave. When the refusal is an untrusted mount point, it is the real program p leads to, found by following its links (resolveJunctionChain); if that fails,
// the error says so and names p.
func RealCLIPath(p string) (string, error) {
	_, err := statCLI(p)
	if err == nil || !isUntrustedMount(err) {
		return p, err
	}
	real, rerr := resolveJunctionChain(p)
	if rerr != nil {
		return p, &UnfollowedChainError{Path: p, Err: rerr}
	}
	if !underJunctionRoot(real, junctionRoots()) {
		return p, &UnfollowedChainError{Path: p, Err: outsideRootsError(real)}
	}
	info, serr := statCLI(real)
	if serr != nil {
		return p, &UnfollowedChainError{Path: p, Err: serr}
	}
	if !info.Mode().IsRegular() {
		return p, &UnfollowedChainError{Path: p, Err: fmt.Errorf("%s is not a file", real)}
	}
	return real, nil
}

// UnfollowedChainError is a path through an untrusted mount point that Coral could not follow to a program.
type UnfollowedChainError struct {
	Path string
	Err  error
}

func (e *UnfollowedChainError) Error() string {
	return fmt.Sprintf("%s goes through a folder Windows will not open (an untrusted mount point), and Coral could not follow it to the program (%v)", e.Path, e.Err)
}

func (e *UnfollowedChainError) Unwrap() error { return e.Err }

// resolveJunctionChain follows the links in p, from its drive down, without letting Windows traverse any of them: each part is looked at with Lstat, and a link (a junction or
// a symbolic link) is read with Readlink and replaced by its target, after which the walk starts again on the new path. Only an absolute path on a drive letter of this
// computer is walked, and every target must be one too: a network share, a mapped drive, a volume GUID path or a device path is refused.
func resolveJunctionChain(p string) (string, error) {
	p = filepath.Clean(p)
	for hops := 0; ; {
		vol := filepath.VolumeName(p)
		if len(vol) != 2 || vol[1] != ':' || !localDrive(vol+`\`) {
			return "", fmt.Errorf("%s is not on a drive of this computer", p)
		}
		parts := strings.Split(strings.Trim(p[len(vol):], `\`), `\`)
		cur := vol + `\`
		followed := false
		for i, part := range parts {
			if part == "" {
				continue
			}
			next := filepath.Join(cur, part)
			info, err := lstatCLI(next)
			if err != nil {
				return "", err
			}
			if info.Mode()&(os.ModeSymlink|os.ModeIrregular) == 0 {
				cur = next
				continue
			}
			target, err := readlinkCLI(next)
			if err != nil {
				return "", err
			}
			if hops++; hops > maxJunctionHops {
				return "", errors.New("too many links")
			}
			if !filepath.IsAbs(target) { // a relative symbolic link is read against the folder that holds it
				target = filepath.Join(cur, target)
			}
			if !underJunctionRoot(target, junctionRoots()) {
				return "", outsideRootsError(target)
			}
			p = filepath.Join(append([]string{filepath.Clean(target)}, parts[i+1:]...)...)
			followed = true
			break
		}
		if !followed {
			return cur, nil
		}
	}
}

// junctionRoots are the folders a followed chain may lead into: every link's target and the program it ends on must lie in the person's profile, their local application
// data, or Program Files. Read at each use, so a test sets them.
var junctionRoots = func() []string {
	var roots []string
	for _, k := range []string{"USERPROFILE", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"} {
		if v := os.Getenv(k); v != "" {
			roots = append(roots, v)
		}
	}
	return roots
}

// underJunctionRoot reports whether p lies in one of roots: compared after filepath.Clean, without regard to case, on a folder boundary (C:\Users\me2 is not in C:\Users\me).
// A root that is not absolute, or is a whole drive, counts for nothing.
func underJunctionRoot(p string, roots []string) bool {
	p = strings.ToLower(filepath.Clean(p))
	for _, r := range roots {
		r = strings.ToLower(filepath.Clean(r))
		if !filepath.IsAbs(r) || len(r) <= len(filepath.VolumeName(r))+1 {
			continue
		}
		if p == r || strings.HasPrefix(p, r+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// FollowedCLIRefusal is why the program a chain of junctions led to is not run, or "": in a temporary folder, or the reason screen gives (an agent's working folder, Coral's
// data folder). screen may be nil.
func FollowedCLIRefusal(real string, screen func(path string) string) string {
	if InTempFolder(real) {
		return "in a temporary folder"
	}
	if screen != nil {
		return screen(real)
	}
	return ""
}

func outsideRootsError(p string) error {
	return fmt.Errorf("%s leads outside your user folders or Program Files", p)
}

// CLIThroughUntrustedMount is binary in the PATH or common-place folder Windows will not open (UntrustedMountDir), followed to the real program (RealCLIPath): the path a
// launch runs, the folder it was in, and whether there was such a folder at all. path is "" when the folder is there but no program in it could be followed to.
func CLIThroughUntrustedMount(binary string) (path, dir string, bad bool) {
	dir, bad = UntrustedMountDir(binary)
	if !bad {
		return "", "", false
	}
	for _, ext := range []string{".exe", ".cmd", ".bat", ""} {
		if real, err := RealCLIPath(filepath.Join(dir, binary+ext)); err == nil && real != filepath.Join(dir, binary+ext) && CheckRunnable(real) == nil {
			return real, dir, true
		}
	}
	return "", dir, true
}
