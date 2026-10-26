package routes

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// winStageCorpus is the differential test of winStageRisk (#8337): every command line below is run through
// winVerbRisk with fakeOutside and the reason (or "" for quiet) it gives today is pinned in
// testdata/winstage_corpus.golden. A split of winStageRisk must leave the file unchanged; a deliberate change to a
// rule regenerates it (UPDATE_WINSTAGE_CORPUS=1) and the diff is the review.
func winStageCorpus() []string {
	var c []string
	c = append(c, winStageHand...)
	// Generated: each verb template against inside, outside, rooted, drive, variable, home, UNC and unreadable paths.
	paths := []string{`a.txt`, `.\sub\a.txt`, `sub/a.txt`, `..\x`, `C:\x`, `/etc/x`, `~\x`, `$env:TEMP\x`, `%TEMP%\x`, `\\srv\sh\x`, `"C:\Program Files\x"`, `'..\y'`, `HKLM:\Software\x`}
	verbs := []string{
		`Remove-Item %s`, `Remove-Item %s -Recurse -Force`, `del /q %s`, `rd /s /q %s`, `erase %s`,
		`Set-Content %s hi`, `Set-Content -Path %s -Value hi`, `Out-File %s`, `Add-Content %s x`, `New-Item %s`, `New-Item -ItemType Directory %s`,
		`Copy-Item .\a %s`, `Copy-Item %s .\a`, `copy a %s`, `xcopy a %s /e`, `robocopy a %s /mir`, `robocopy %s b /mov`,
		`Move-Item .\a %s`, `move %s a`, `Rename-Item %s b`, `ren %s b`,
		`attrib +h %s`, `expand a.cab %s`, `makecab a %s`, `tar -xf a.tar -C %s`, `tar -xf a.tar --directory=%s`, `7z x a.7z -o%s`, `unzip a.zip -d %s`,
		`curl -o %s http://e/x`, `curl --output %s http://e/x`, `wget -O %s http://e/x`, `Invoke-WebRequest http://e -OutFile %s`, `iwr http://e -o %s`,
		`git clone http://e/r %s`, `Start-Process -FilePath x.exe -WorkingDirectory %s`, `start /d %s x.exe`,
		`cd %s && del x`, `Set-Location %s; Remove-Item x`, `echo hi > %s`, `echo hi >> %s`, `dir | Out-File %s`,
		`& %s`, `. %s`, `cmd /c del %s`, `powershell -Command "Remove-Item %s"`, `pwsh -c "Set-Content %s x"`, `bash -c "rm %s"`,
		`Get-Content %s`, `Get-ChildItem %s`, `Stop-Service %s`, `Set-ItemProperty -Path %s -Name a -Value b`, `Invoke-Thing -Path %s`,
		`for %%f in (*) do del %s`, `if exist x del %s`, `if "%%A%%"=="1" del %s`, `call del %s`, `forfiles /c "cmd /c del %s"`,
	}
	for _, v := range verbs {
		for _, p := range paths {
			c = append(c, strings.ReplaceAll(v, "%s", p))
		}
	}
	// Case and alias variants of the system verbs.
	for _, v := range []string{"shutdown /s", "Stop-Computer", "format C:", "diskpart", "Format-Volume -DriveLetter C", "Set-ExecutionPolicy Bypass", "iex $x", "Invoke-Expression $x", "reg delete HKLM\\x", "reg query HKLM\\x", "reg add HKCU\\x", "icacls x /grant a:F", "icacls x", "sc stop x", "sc query", "sc a.txt hi", "net use", "net use Z: \\\\s\\x", "net user a b /add", "cipher /w:C:", "cipher /e", "assoc .x=y", "assoc .x", "ftype a=b", "ftype a", "schtasks /create /tn a", "schtasks /query", "netsh advfirewall set", "netsh show", "wmic process call create x", "wmic os get", "taskkill /f /im x", "taskkill /im x", "mklink a b", "Stop-Process -Force -Id 1", "kill -Force 1", "Stop-Process -Id 1", "xargs rm", "xargs echo"} {
		c = append(c, v, strings.ToUpper(v), strings.ToLower(v))
	}
	return c
}

func TestWinStageRiskCorpusGolden(t *testing.T) {
	const golden = "testdata/winstage_corpus.golden"
	var out strings.Builder
	seen := map[string]bool{}
	for _, cmd := range winStageCorpus() {
		if seen[cmd] {
			continue
		}
		seen[cmd] = true
		out.WriteString(strconv.Quote(cmd) + "\t" + strconv.Quote(winVerbRisk(cmd, fakeOutside)) + "\n")
	}
	if os.Getenv("UPDATE_WINSTAGE_CORPUS") != "" {
		require.NoError(t, os.WriteFile(golden, []byte(out.String()), 0o644))
		return
	}
	f, err := os.Open(golden)
	require.NoError(t, err)
	defer f.Close()
	want := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "\t")
		require.True(t, ok, sc.Text())
		want[k] = v
	}
	require.Equal(t, len(want), len(seen), "corpus and golden differ in size: regenerate with UPDATE_WINSTAGE_CORPUS=1 and review the diff")
	for cmd := range seen {
		got := strconv.Quote(winVerbRisk(cmd, fakeOutside))
		if w, ok := want[strconv.Quote(cmd)]; !ok || w != got {
			t.Errorf("winVerbRisk(%s)\n  want %s\n  got  %s", strconv.Quote(cmd), w, got)
		}
	}
}
