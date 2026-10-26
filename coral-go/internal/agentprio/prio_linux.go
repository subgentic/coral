//go:build linux

package agentprio

import (
	"os"
	"strconv"
	"strings"
)

func rawToNice(v int) int { return 20 - v }

// OOMAdj is the oom_score_adj agents get on Linux. The kernel's out-of-memory killer picks the process with the highest score (its memory use, plus this); an agent CLI (a Node
// process of several hundred MB) and Coral itself both start at 0, so under a memory limit it killed Coral, the larger of the two, and every agent's terminal with it (#8734).
// Agents are first to go at +500. Raising the value of a process one owns needs no privilege.
const OOMAdj = 500

// preferOOMKill raises pid's oom_score_adj to OOMAdj for the agent and what it starts later (children inherit it), unless it is already that high. Best effort: a process that ended, or a
// system without the file, is left alone.
func preferOOMKill(pid int) {
	if pid <= 0 || Level() != Low {
		return
	}
	path := "/proc/" + strconv.Itoa(pid) + "/oom_score_adj"
	if cur, err := os.ReadFile(path); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(cur))); err == nil && n >= OOMAdj {
			return
		}
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(OOMAdj)), 0); err != nil {
		logOnce("oom", err)
	}
}
