//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

// #582: Codex's standalone installer gives %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe, a junction to ~\.codex\packages\standalone\current\bin, and current a junction to
// releases\<version>. On a Windows that refuses that chain (an untrusted mount point) Coral follows it itself to the real codex.exe, at each use.

func mkJunction(t *testing.T, link, target string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(link), 0o755))
	out, err := consoletest.HiddenCommand("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	require.NoError(t, err, "mklink /J: %s", out)
}

// codexLayout builds the installer's layout under a profile folder whose name has a space (as many Windows accounts do), and returns the installer's path and the real file.
func codexLayout(t *testing.T, version string) (profile, installerPath, real string) {
	t.Helper()
	profile = filepath.Join(t.TempDir(), "Test User")
	setJunctionRoots(t, profile)
	standalone := filepath.Join(profile, ".codex", "packages", "standalone")
	bin := filepath.Join(standalone, "releases", version, "bin")
	require.NoError(t, os.MkdirAll(bin, 0o755))
	for _, name := range []string{"codex.exe", "codex-code-mode-host.exe", "codex-exec-server.exe"} {
		require.NoError(t, os.WriteFile(filepath.Join(bin, name), []byte("x"), 0o755))
	}
	mkJunction(t, filepath.Join(standalone, "current"), filepath.Join(standalone, "releases", version))
	local := filepath.Join(profile, "AppData", "Local")
	mkJunction(t, filepath.Join(local, "Programs", "OpenAI", "Codex", "bin"), filepath.Join(standalone, "current", "bin"))
	return profile, filepath.Join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"), filepath.Join(bin, "codex.exe")
}

// setJunctionRoots makes profile the person's folders and puts Program Files beside it, so the roots a chain may lead into are the test's own, never this machine's.
func setJunctionRoots(t *testing.T, profile string) {
	t.Helper()
	base := filepath.Dir(profile)
	t.Setenv("USERPROFILE", profile)
	t.Setenv("LOCALAPPDATA", filepath.Join(profile, "AppData", "Local"))
	t.Setenv("ProgramFiles", filepath.Join(base, "Program Files"))
	t.Setenv("ProgramFiles(x86)", filepath.Join(base, "Program Files (x86)"))
}

// refuseJunctions stands in for a Windows that will not traverse a junction: a stat of any path that goes through one (or is one) fails with ERROR_UNTRUSTED_MOUNT_POINT.
func refuseJunctions(t *testing.T) {
	t.Helper()
	prev := statCLI
	statCLI = func(p string) (os.FileInfo, error) {
		p = filepath.Clean(p)
		vol := filepath.VolumeName(p)
		cur := vol + `\`
		for _, part := range strings.Split(strings.Trim(p[len(vol):], `\`), `\`) {
			if part == "" {
				continue
			}
			cur = filepath.Join(cur, part)
			if fi, err := os.Lstat(cur); err == nil && fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				return nil, &os.PathError{Op: "GetFileAttributesEx", Path: p, Err: errorUntrustedMountPoint}
			}
		}
		return os.Stat(p)
	}
	t.Cleanup(func() { statCLI = prev })
}

func TestTheInstallersCodexPathIsFollowedToTheRealProgram(t *testing.T) {
	_, installerPath, real := codexLayout(t, "0.172.0-x86_64-pc-windows-msvc")
	refuseJunctions(t)
	_, err := statCLI(installerPath)
	require.True(t, isUntrustedMount(err), "the stand-in refuses the chain, as Windows 26300 does")

	got, err := RealCLIPath(installerPath)
	require.NoError(t, err)
	assert.Equal(t, real, got, "the real codex.exe, not codex-code-mode-host.exe or codex-exec-server.exe")
	assert.NoError(t, ValidateCLIPath(installerPath), "Settings takes the path the installer gives")
}

// Codex updates itself: current is pointed at a new releases\<version>. The path is followed again at each use, so the new version is what runs.
func TestAnUpdatedCodexIsFollowedAtTheNextUse(t *testing.T) {
	profile, installerPath, _ := codexLayout(t, "0.172.0-x86_64-pc-windows-msvc")
	refuseJunctions(t)
	standalone := filepath.Join(profile, ".codex", "packages", "standalone")
	newBin := filepath.Join(standalone, "releases", "0.173.0-x86_64-pc-windows-msvc", "bin")
	require.NoError(t, os.MkdirAll(newBin, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(newBin, "codex.exe"), []byte("x"), 0o755))
	require.NoError(t, os.Remove(filepath.Join(standalone, "current"))) // removes the junction, not what it leads to
	mkJunction(t, filepath.Join(standalone, "current"), filepath.Join(standalone, "releases", "0.173.0-x86_64-pc-windows-msvc"))

	got, err := RealCLIPath(installerPath)
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(newBin, "codex.exe"), got)
}

func TestACodexPathSetInSettingsLaunchesTheRealProgram(t *testing.T) {
	_, installerPath, real := codexLayout(t, "0.172.0-x86_64-pc-windows-msvc")
	refuseJunctions(t)
	got, err := FindCLIForLaunch(map[string]string{CLIPathSettingKey("codex"): installerPath}, "codex")
	require.NoError(t, err)
	assert.Equal(t, real, got)
}

func TestTheStandaloneCodexIsFoundInItsCommonPlace(t *testing.T) {
	profile, _, real := codexLayout(t, "0.172.0-x86_64-pc-windows-msvc")
	refuseJunctions(t)
	t.Setenv("LOCALAPPDATA", filepath.Join(profile, "AppData", "Local"))
	t.Setenv("APPDATA", filepath.Join(profile, "AppData", "Roaming"))
	assert.Equal(t, real, FindCLIInCommonPaths("codex"))
}

// A path Windows opens is used as it is: nothing is followed unless Windows refused it.
func TestAPathWindowsOpensIsKeptAsItIs(t *testing.T) {
	_, installerPath, real := codexLayout(t, "0.172.0-x86_64-pc-windows-msvc")
	// Windows opens it here: a stand-in answers as Windows does when it follows the junctions (some Windows builds refuse a chain under a temp folder, which is the case above).
	prev := statCLI
	t.Cleanup(func() { statCLI = prev })
	statCLI = func(string) (os.FileInfo, error) { return os.Stat(real) }
	got, err := RealCLIPath(installerPath)
	require.NoError(t, err)
	assert.Equal(t, installerPath, got)
}

// A chain that leads nowhere is refused with a sentence that names the path, and Settings says it.
func TestAChainThatLeadsNowhereIsSaidSo(t *testing.T) {
	profile, installerPath, _ := codexLayout(t, "0.172.0-x86_64-pc-windows-msvc")
	refuseJunctions(t)
	require.NoError(t, os.RemoveAll(filepath.Join(profile, ".codex", "packages", "standalone", "releases")))
	_, err := RealCLIPath(installerPath)
	var unfollowed *UnfollowedChainError
	require.ErrorAs(t, err, &unfollowed)
	err = ValidateCLIPath(installerPath)
	require.Error(t, err)
	assert.Contains(t, err.Error(), installerPath)
	assert.Contains(t, err.Error(), "could not follow it to the program")
}

// The walk never leaves this computer's drives, and a loop of links ends.
func TestTheWalkRefusesSharesAndLoops(t *testing.T) {
	prevL, prevR := lstatCLI, readlinkCLI
	t.Cleanup(func() { lstatCLI, readlinkCLI = prevL, prevR })
	dir := t.TempDir()
	setJunctionRoots(t, dir)
	link := filepath.Join(dir, "bin")
	require.NoError(t, os.Mkdir(link, 0o755))
	lstatCLI = func(p string) (os.FileInfo, error) {
		fi, err := os.Lstat(p)
		if err != nil || filepath.Base(p) != "bin" {
			return fi, err
		}
		return irregular{fi}, nil
	}
	for _, target := range []string{`\\server\share\codex`, `\\?\Volume{0b1f}\codex`, `\\.\pipe\x`} {
		readlinkCLI = func(string) (string, error) { return target, nil }
		_, err := resolveJunctionChain(filepath.Join(link, "codex.exe"))
		assert.Error(t, err, "%s is not followed", target)
	}
	readlinkCLI = func(string) (string, error) { return link, nil } // bin leads to itself
	_, err := resolveJunctionChain(filepath.Join(link, "codex.exe"))
	assert.ErrorContains(t, err, "too many links")
}

type irregular struct{ os.FileInfo }

func (i irregular) Mode() os.FileMode { return i.FileInfo.Mode() | os.ModeIrregular }

// coral-go-team Security on #582: a chain is followed only into the person's folders or Program Files, compared without regard to case and on a folder boundary.
func TestUnderJunctionRootIsAFolderBoundaryWithoutCase(t *testing.T) {
	roots := []string{`C:\Users\me`, `C:\Users\me\AppData\Local`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\`, `relative\root`, ``}
	for p, want := range map[string]bool{
		`C:\Users\me\.codex\packages\standalone\releases\1.0.0\bin\codex.exe`: true,
		`c:\USERS\ME\.codex\bin\codex.exe`:                                    true,
		`C:\Users\me`:                                                         true,
		`C:\Program Files\OpenAI\codex.exe`:                                   true,
		`C:\Program Files (x86)\Codex\codex.exe`:                              true,
		`D:\tools\codex.exe`:                                                  false,
		`C:\Users\me2\codex\codex.exe`:                                        false,
		`C:\Users\me\..\me2\codex.exe`:                                        false,
		`C:\Program Files Extra\codex.exe`:                                    false,
		`C:\Windows\Temp\codex.exe`:                                           false, // a whole drive (C:\) is no root
	} {
		assert.Equal(t, want, underJunctionRoot(p, roots), p)
	}
}

// A junction in the chain that leads out of the roots stops the walk: to another drive's folder, or to a folder whose name only begins with the profile's.
func TestAChainThatLeadsOutsideTheRootsIsRefused(t *testing.T) {
	for _, outside := range []string{"tools", "Test User2"} {
		t.Run(outside, func(t *testing.T) {
			profile, installerPath, _ := codexLayout(t, "1.0.0")
			refuseJunctions(t)
			elsewhere := filepath.Join(filepath.Dir(profile), outside, "1.0.0")
			require.NoError(t, os.MkdirAll(filepath.Join(elsewhere, "bin"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(elsewhere, "bin", "codex.exe"), []byte("x"), 0o755))
			current := filepath.Join(profile, ".codex", "packages", "standalone", "current")
			require.NoError(t, os.Remove(current))
			mkJunction(t, current, elsewhere)

			_, err := RealCLIPath(installerPath)
			var unfollowed *UnfollowedChainError
			require.ErrorAs(t, err, &unfollowed)
			assert.ErrorContains(t, err, "leads outside your user folders or Program Files")
			_, err = FindCLIForLaunch(map[string]string{CLIPathSettingKey("codex"): installerPath}, "codex")
			assert.Error(t, err, "a launch does not run it")
		})
	}
}

// coral-go-team Security on #582: the program a configured path's junctions lead to is screened as PATH and the common places are (a temp folder, the caller's screen).
func TestAConfiguredPathsJunctionsAreScreenedAtTheProgram(t *testing.T) {
	_, installerPath, real := codexLayout(t, "1.0.0")
	refuseJunctions(t)
	settings := map[string]string{CLIPathSettingKey("codex"): installerPath}

	refuse := func(p string) string {
		if p == real {
			return "in the working folder of agent Test"
		}
		return ""
	}
	_, err := FindCLIForLaunchScreened(settings, "codex", refuse)
	var pe *CLIPathError
	require.ErrorAs(t, err, &pe)
	assert.ErrorContains(t, err, "in the working folder of agent Test")
	_, err = LaunchCLIScreened(settings, "codex", refuse)
	assert.ErrorAs(t, err, &pe, "a restart, resume or wake refuses it too")

	tmp := filepath.Dir(filepath.Dir(real)) // the release folder: the program is in the temp folder
	t.Setenv("TMP", tmp)
	t.Setenv("TEMP", tmp)
	_, err = FindCLIForLaunch(settings, "codex")
	assert.ErrorContains(t, err, "in a temporary folder")
}

// A configured path Windows opens as it is is not screened here, as before.
func TestAConfiguredPathWindowsOpensIsNotScreened(t *testing.T) {
	_, _, real := codexLayout(t, "1.0.0") // the real file: a path with no junction in it, which Windows opens
	got, err := FindCLIForLaunchScreened(map[string]string{CLIPathSettingKey("codex"): real}, "codex", func(string) string { return "refused" })
	require.NoError(t, err)
	assert.Equal(t, strings.ToLower(real), strings.ToLower(got))
}
