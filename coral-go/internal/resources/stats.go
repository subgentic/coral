package resources

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/subgentic/coral/internal/safego"
)

// Stats is what one resource's machine looks like now (#17560): the numbers an agent needs to pick a box (is it up, how loaded, how much memory and disk is free). They come from the machine itself: gopsutil here,
// one fixed read-only command over ssh on a remote one. Never the resource's description or anything an agent typed.
type Stats struct {
	State        string  `json:"state"` // ok | unreachable | no_stats (ssh connected but the box has no Unix tools, such as Windows) | unavailable (no way to read it yet)
	LoadPerCore  float64 `json:"load_per_core,omitempty"`
	CPUCount     int     `json:"cpu_count,omitempty"`
	MemAvailMB   int64   `json:"mem_available_mb,omitempty"`
	DiskFreeGB   float64 `json:"disk_free_gb,omitempty"`
	SampledAtUTC string  `json:"sampled_at,omitempty"`
}

// Words is the one short line the CLI prints.
func (s Stats) Words() string {
	switch s.State {
	case "ok":
		return fmt.Sprintf("up; load %.2f per core on %d cores; %d MB memory free; %.0f GB disk free", s.LoadPerCore, s.CPUCount, s.MemAvailMB, s.DiskFreeGB)
	case "unreachable":
		return "unreachable (ssh failed or timed out)"
	case NoStats:
		return "up (no stats on this OS)"
	case "checking":
		return "checking"
	default:
		return "stats not available for this machine"
	}
}

// NoStats is the state of a remote machine that took the ssh connection but could not run the Unix stats command (Windows' cmd.exe): it is up, and its numbers are unknown (#21948).
const NoStats = "no_stats"

// RemoteExit is what an SSHRunner answers when ssh connected and the remote command ran but exited non-zero (ssh itself exits 255 for a connection failure). The runner still returns the output it read.
type RemoteExit struct{ Code int }

func (e *RemoteExit) Error() string { return fmt.Sprintf("the remote command exited %d", e.Code) }

// statsScript is the whole command a remote machine is asked to run: fixed text, read-only, with no input from anywhere.
const statsScript = `uptime; echo '---'; (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null); echo '---'; df -k . | tail -1; echo '---'; free -m 2>/dev/null | sed -n 2p`

var (
	loadRe     = regexp.MustCompile(`load averages?: *([0-9.]+)`)
	sshAliasRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	nonSlugRe  = regexp.MustCompile(`[^a-z0-9]+`)
)

// ParseRemoteStats reads statsScript's output. A part that is not there stays zero; State is ok when the load and the core count were read.
func ParseRemoteStats(out string) Stats {
	parts := strings.Split(out, "---")
	st := Stats{State: "unavailable"}
	if len(parts) < 3 {
		return st
	}
	if m := loadRe.FindStringSubmatch(parts[0]); m != nil {
		if l, err := strconv.ParseFloat(m[1], 64); err == nil {
			st.LoadPerCore = l
		}
	}
	if n, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil && n > 0 {
		st.CPUCount = n
		st.LoadPerCore = st.LoadPerCore / float64(n)
	}
	if f := strings.Fields(parts[2]); len(f) >= 4 {
		if kb, err := strconv.ParseInt(f[3], 10, 64); err == nil {
			st.DiskFreeGB = float64(kb) / 1048576
		}
	}
	if len(parts) > 3 {
		if f := strings.Fields(parts[3]); len(f) >= 7 {
			if mb, err := strconv.ParseInt(f[len(f)-1], 10, 64); err == nil {
				st.MemAvailMB = mb
			}
		}
	}
	if st.CPUCount > 0 {
		st.State = "ok"
	}
	return st
}

// SSHRunner runs script on the ssh alias and answers its output.
type SSHRunner func(ctx context.Context, alias, script string) (string, error)

func realSSH(ctx context.Context, alias, script string) (string, error) {
	cmd := exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes", "--", alias, script)
	out := &cappedBuffer{max: maxSSHOutput}
	cmd.Stdout = out
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() != 255 && ee.ExitCode() >= 0 {
		err = &RemoteExit{Code: ee.ExitCode()} // ssh itself connected: the command is what failed
	}
	return out.b.String(), err
}

// maxSSHOutput is the most a machine's answer is read: the fixed script prints a few lines, so more is a broken or hostile box, and the rest is dropped.
const maxSSHOutput = 64 << 10

// cappedBuffer keeps the first max bytes written and drops the rest without an error, so the ssh process is never blocked on a full pipe.
type cappedBuffer struct {
	b   strings.Builder
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.b.Len(); room > 0 {
		if len(p) > room {
			c.b.Write(p[:room])
		} else {
			c.b.Write(p)
		}
	}
	return len(p), nil
}

// StatsBoard keeps one sample per machine for a minute, so a page or a claim never starts a probe of its own.
type StatsBoard struct {
	Run SSHRunner // nil: ssh
	TTL time.Duration
	Now func() time.Time

	mu     sync.Mutex
	cache  map[string]Stats
	at     map[string]time.Time
	flight map[string]bool
}

func (b *StatsBoard) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

func (b *StatsBoard) ttl() time.Duration {
	if b.TTL > 0 {
		return b.TTL
	}
	return time.Minute
}

// Alias is the ssh host for a machine name: the name as a slug (the Operator's own ssh config names it, as in "ssh epoch"); "" when the name is not one.
func statsAlias(machine string) string {
	s := strings.Trim(nonSlugRe.ReplaceAllString(strings.ToLower(machine), "-"), "-")
	if !sshAliasRe.MatchString(s) {
		return ""
	}
	return s
}

// Get answers the machine's stats: a fresh sample at once, a stale one while it is read again in the background, and for a remote machine never seen before "checking" while one read runs in the
// background (#17656: a list or a claim never waits on ssh, and concurrent first looks start one read, not one each). This machine is read directly. where is the resource's: here, remote or "" (nil).
func (b *StatsBoard) Get(machine, where string) *Stats {
	if where != "here" && where != "remote" {
		return nil
	}
	key := where + ":" + machine
	b.mu.Lock()
	if b.cache == nil {
		b.cache, b.at, b.flight = map[string]Stats{}, map[string]time.Time{}, map[string]bool{}
	}
	st, have := b.cache[key]
	age := b.now().Sub(b.at[key])
	if have && age < b.ttl() {
		b.mu.Unlock()
		return &st
	}
	if have {
		if !b.flight[key] {
			b.flight[key] = true
			safego.Go("resources:refresh", func() { b.refresh(machine, where, key) })
		}
		b.mu.Unlock()
		return &st
	}
	if where == "remote" {
		if !b.flight[key] {
			b.flight[key] = true
			safego.Go("resources:refresh", func() { b.refresh(machine, where, key) })
		}
		b.mu.Unlock()
		return &Stats{State: "checking"}
	}
	b.mu.Unlock()
	b.refresh(machine, where, key)
	b.mu.Lock()
	st = b.cache[key]
	b.mu.Unlock()
	return &st
}

func (b *StatsBoard) refresh(machine, where, key string) {
	var st Stats
	if where == "here" {
		st = localStats()
	} else {
		st = b.remoteStats(machine)
	}
	st.SampledAtUTC = b.now().UTC().Format(time.RFC3339)
	b.mu.Lock()
	b.cache[key], b.at[key] = st, b.now()
	delete(b.flight, key)
	b.mu.Unlock()
}

func (b *StatsBoard) remoteStats(machine string) Stats {
	alias := statsAlias(machine)
	if alias == "" {
		return Stats{State: "unavailable"}
	}
	run := b.Run
	if run == nil {
		run = realSSH
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, err := run(ctx, alias, statsScript)
	var re *RemoteExit
	if err != nil && !errors.As(err, &re) {
		// ssh exits 255 when it cannot connect, but a remote command can exit 255 too: Windows' cmd.exe does on the script's POSIX redirects ("The system cannot find the path specified"), which marked
		// a Windows box that is up unreachable and closed it to pool runs (#22128). Unless the read timed out, one fixed command every shell runs the same way (cmd, PowerShell, sh) tells the two apart.
		if ctx.Err() != nil || !b.connects(alias) {
			return Stats{State: "unreachable"}
		}
		return Stats{State: NoStats}
	}
	st := ParseRemoteStats(out)
	if st.State != "ok" && re != nil {
		return Stats{State: NoStats} // connected, but the box could not run the Unix command (a Windows machine's cmd.exe)
	}
	return st
}

// connectProbe is the command that only answers whether ssh connects: "exit 0" exits 0 in cmd.exe, PowerShell and sh alike.
const connectProbe = "exit 0"

// connects reports whether ssh reaches alias and runs a command there: the probe exits 0, or exits non-zero after ssh connected (a RemoteExit).
func (b *StatsBoard) connects(alias string) bool {
	run := b.Run
	if run == nil {
		run = realSSH
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_, err := run(ctx, alias, connectProbe)
	var re *RemoteExit
	return err == nil || errors.As(err, &re)
}

func localStats() Stats {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	st := Stats{State: "ok", CPUCount: runtime.NumCPU()}
	if a, err := load.AvgWithContext(ctx); err == nil && st.CPUCount > 0 {
		st.LoadPerCore = a.Load1 / float64(st.CPUCount)
	}
	if v, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		st.MemAvailMB = int64(v.Available >> 20)
	}
	if u, err := disk.UsageWithContext(ctx, "/"); err == nil {
		st.DiskFreeGB = float64(u.Free) / (1 << 30)
	}
	return st
}

// Cached is the last sample of a machine and never reads one (nil when there is none yet): the pool's veto must answer at once, under the queue's lock.
func (b *StatsBoard) Cached(machine, where string) *Stats {
	b.mu.Lock()
	defer b.mu.Unlock()
	st, ok := b.cache[where+":"+machine]
	if !ok {
		return nil
	}
	return &st
}

// Closed reports whether what is known of a machine closes it to new runs through a pool (#17586): under 1 GB of free memory or 2 GB of free disk. Nothing known, or unreachable-but-never-sampled, leaves it open;
// a machine whose last sample says unreachable is closed, as a run sent there would fail.
func (b *StatsBoard) Closed(machine, where string) bool {
	st := b.Cached(machine, where)
	if st == nil {
		return false
	}
	switch st.State {
	case "unreachable":
		return true
	case "ok":
		return st.MemAvailMB > 0 && st.MemAvailMB < 1024 || st.DiskFreeGB > 0 && st.DiskFreeGB < 2
	}
	return false
}
