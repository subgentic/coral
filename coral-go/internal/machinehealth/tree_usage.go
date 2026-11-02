package machinehealth

import "context"

// TreeUsage is the CPU seconds (user and system) and resident bytes summed over the process tree under root, root included, and how many processes it holds (#12111, auto-sleep).
// It reads process ids, parent ids and each process's own usage numbers: no command line, no environment, no image name. ok is false when the process table could not be read or
// the tree is larger than maxProcs: a caller deciding whether an agent is quiet treats that as busy. A process that exits between the two reads is skipped, not an error.
func TreeUsage(ctx context.Context, root int, maxProcs int) (cpu float64, rss uint64, procs int, ok bool) {
	if root <= 0 {
		return 0, 0, 0, false
	}
	pids := descendants(ctx, []int{root})
	if len(pids) == 0 || len(pids) > maxProcs {
		return 0, 0, len(pids), false
	}
	for _, pid := range pids {
		c, r, read := procUsage(ctx, pid)
		if !read {
			continue
		}
		cpu += c
		rss += r
		procs++
	}
	return cpu, rss, procs, true
}
