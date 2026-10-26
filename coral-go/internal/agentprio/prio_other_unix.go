//go:build !windows && !linux

package agentprio

func rawToNice(v int) int { return v }

// preferOOMKill is Linux's oom_score_adj; other systems have no such setting.
func preferOOMKill(pid int) {}
