package board

import (
	"fmt"
	"strings"
)

// ApprovalWords says what approving a check approves, in plain words: the script and its SHA-256, the arguments one by one, the folder, how often, who it speaks as, who gets its lines, and whether it may write. It is what
// the Operator reads before they approve (the approval row shows it as is) and nothing in it is the script's own text.
func (c HealthCheck) ApprovalWords() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Run the script %s (SHA-256 %s)", c.ScriptSrc, c.ScriptHash)
	if len(c.Args) == 0 {
		b.WriteString(" with no arguments")
	} else {
		b.WriteString(" with the arguments")
		for i, a := range c.Args {
			fmt.Fprintf(&b, " [%d] %q", i+1, a)
		}
	}
	fmt.Fprintf(&b, ", in the folder %s, %s.", c.Dir, c.Schedule().String())
	to := c.To
	if to == "" {
		to = "the Orchestrator"
	}
	fmt.Fprintf(&b, " Its lines go to %s as automated notices.", to)
	fmt.Fprintf(&b, " It runs as %s: whatever it reads from this board it reads as %s.", c.ActsAs, c.ActsAs)
	if c.MayWrite {
		fmt.Fprintf(&b, " It MAY WRITE as %s: post to members, add tasks, comment on tasks and reassign them (5 a run, 6 an hour), each marked \"via check %s\". It cannot ask you anything or put anything in your Needs you.", c.ActsAs, c.Name)
	} else {
		b.WriteString(" It can only read: it cannot post, add a task or change anything.")
	}
	b.WriteString(" Files the script reads or runs itself are not covered by this approval.")
	return b.String()
}
