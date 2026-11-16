// Package machineprobe reads what a computer is (its OS, cores, memory, and whether Go, node and Chrome are there) from one fixed read-only script, and turns that into the facts, slots and weight of a resource (#17588).
// The script is run by the caller, here or over ssh; nothing in this package runs anything or takes input from an agent.
package machineprobe

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Script is the whole command a machine is asked to run: fixed text, POSIX sh, read-only. It ends with a marker line, so an answer cut short is told from a complete one.
const Script = `PATH="$PATH:$HOME/.local/go/bin:/usr/local/go/bin:$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin"
echo "os=$(uname -s 2>/dev/null | tr 'A-Z' 'a-z')"
echo "arch=$(uname -m 2>/dev/null)"
echo "cores=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"
if [ -r /proc/meminfo ]; then echo "mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"; else echo "mem_mb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 ))"; fi
echo "disk_gb=$(df -k . 2>/dev/null | awk 'NR==2{print int($4/1048576)}')"
echo "go=$(go version 2>/dev/null)"
echo "node=$(node --version 2>/dev/null)"
if command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || [ -d "/Applications/Google Chrome.app" ]; then echo "chrome=yes"; fi
echo "probe-end"`

// CheckScript is the tiny suite a box runs to show Go works on it: a throwaway module with one empty test, in a folder it makes and removes, with no network and nothing of anyone's. POSIX sh, fixed text.
const CheckScript = `PATH="$PATH:$HOME/.local/go/bin:/usr/local/go/bin:/usr/local/bin:/opt/homebrew/bin"
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
cd "$d" || exit 1
printf 'module check\n\ngo 1.18\n' > go.mod
printf 'package check\nimport "testing"\nfunc TestCheck(t *testing.T) {}\n' > check_test.go
GOFLAGS=-mod=mod GOPROXY=off go test ./... 2>&1
echo "check-end"`

// Probe is what one machine said about itself.
type Probe struct {
	OS, Arch string
	Cores    int
	MemMB    int64
	DiskGB   int64
	Go       string // major.minor, "" when Go is not there
	Node     string // major, "" when node is not there
	Chrome   bool
}

var (
	goRe   = regexp.MustCompile(`go version go([0-9]+)\.([0-9]+)`)
	nodeRe = regexp.MustCompile(`^v?([0-9]+)\.`)
	osRe   = regexp.MustCompile(`^[a-z]{3,16}$`)
	archRe = regexp.MustCompile(`^[A-Za-z0-9_]{2,16}$`)
)

// Parse reads Script's output. It fails, saying why, when the script did not finish or the machine is not one it can size (no OS, no core count).
func Parse(out string) (Probe, error) {
	var p Probe
	kv := map[string]string{}
	end := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "probe-end" {
			end = true
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[k] = strings.TrimSpace(v)
		}
	}
	if !end {
		return p, fmt.Errorf("the machine's answer was cut short (no end marker); is it a Mac or Linux box with a POSIX shell? A Windows box is not set up this way yet: define it with resource define")
	}
	if !osRe.MatchString(kv["os"]) {
		return p, fmt.Errorf("the machine did not say which OS it is (uname gave %q); a Windows box is not set up this way yet: define it with resource define", kv["os"])
	}
	p.OS = kv["os"]
	if archRe.MatchString(kv["arch"]) {
		p.Arch = kv["arch"]
	}
	n, err := strconv.Atoi(kv["cores"])
	if err != nil || n < 1 {
		return p, fmt.Errorf("the machine did not say how many cores it has (got %q)", kv["cores"])
	}
	p.Cores = n
	p.MemMB, _ = strconv.ParseInt(kv["mem_mb"], 10, 64)
	p.DiskGB, _ = strconv.ParseInt(kv["disk_gb"], 10, 64)
	if m := goRe.FindStringSubmatch(kv["go"]); m != nil {
		p.Go = m[1] + "." + m[2]
	}
	if m := nodeRe.FindStringSubmatch(kv["node"]); m != nil {
		p.Node = m[1]
	}
	p.Chrome = kv["chrome"] == "yes"
	return p, nil
}

// MemGB is the memory in whole GB (at least 1 when it was read).
func (p Probe) MemGB() int64 {
	gb := (p.MemMB + 512) / 1024
	if gb < 1 && p.MemMB > 0 {
		gb = 1
	}
	return gb
}

// Facts are what a pool matches a command's needs against.
func (p Probe) Facts() map[string]string {
	f := map[string]string{"os": p.OS, "cores": strconv.Itoa(p.Cores)}
	if p.Arch != "" {
		f["arch"] = p.Arch
	}
	if gb := p.MemGB(); gb > 0 {
		f["memory_gb"] = strconv.FormatInt(gb, 10)
	}
	if p.Go != "" {
		f["go"] = p.Go
	}
	if p.Node != "" {
		f["node"] = p.Node
	}
	if p.Chrome {
		f["chrome"] = "yes"
	}
	return f
}

// Slots is how many heavy runs the box takes at once: a core budget of 4 and a memory budget of 4 GB each, from 1 to 4.
func (p Probe) Slots() int {
	n := p.Cores / 4
	if gb := int(p.MemGB() / 4); p.MemMB > 0 && gb < n {
		n = gb
	}
	if n < 1 {
		n = 1
	}
	if n > 4 {
		n = 4
	}
	return n
}

// Weight is the box's share when a pool spreads work: its cores.
func (p Probe) Weight() int { return p.Cores }

// Description is the text a new resource starts with: what the box is and has, how it was set up, and how to reach it. A person's own description is never replaced by it.
func (p Probe) Description(alias string, here bool) string {
	has := []string{}
	if p.Go != "" {
		has = append(has, "Go "+p.Go)
	}
	if p.Node != "" {
		has = append(has, "node "+p.Node)
	}
	if p.Chrome {
		has = append(has, "Chrome")
	}
	line1 := fmt.Sprintf("%s %s, %d cores, %d GB memory", p.OS, p.Arch, p.Cores, p.MemGB())
	if len(has) > 0 {
		line1 += "; has " + strings.Join(has, ", ")
	} else {
		line1 += "; no Go, node or Chrome found"
	}
	if here {
		return line1 + ".\nThe machine this Coral runs on: a run through it happens here.\nSet up by coral-board resource setup."
	}
	return line1 + ".\nReach it with ssh " + alias + "; a run through it is sent there.\nSet up by coral-board resource setup."
}
