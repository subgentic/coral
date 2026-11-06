package routes

import (
	"fmt"
	"strings"
)

// The line diff of the Markdown editor's Send to agent (#13802): the Operator's saved version against the version before it. Hand-written (no new dependency), small and bounded: files are at most 2 MiB, the
// part that differs is compared by the longest common subsequence only while that fits editDiffCells, and a bigger change is simply "too big to show" (the message then carries the limit note and both
// version links). Hunks are whole: the caller sends all of them or none.

const (
	editDiffContext = 2         // unchanged lines kept around a change
	editDiffCells   = 4_000_000 // lines changed in old * lines changed in new: the most the comparison will do
)

type diffOp struct {
	kind byte // ' ' kept, '-' removed, '+' added
	text string
}

// splitDiffLines is the lines of s, without their line ends ("\r\n" and "\n" are one line end each); a final line end does not make an empty last line.
func splitDiffLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// lineDiffOps is the edit script from a to b. ok is false when the changed part is too big to compare.
func lineDiffOps(a, b []string) (ops []diffOp, ok bool) {
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	sa, sb := len(a), len(b)
	for sa > pre && sb > pre && a[sa-1] == b[sb-1] {
		sa--
		sb--
	}
	midA, midB := a[pre:sa], b[pre:sb]
	if len(midA) > 0 && len(midB) > 0 && len(midA)*len(midB) > editDiffCells {
		return nil, false
	}
	for _, l := range a[:pre] {
		ops = append(ops, diffOp{' ', l})
	}
	// longest common subsequence of the changed part
	n, m := len(midA), len(midB)
	lcs := make([][]int32, n+1)
	for i := range lcs {
		lcs[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			switch {
			case midA[i] == midB[j]:
				lcs[i][j] = lcs[i+1][j+1] + 1
			case lcs[i+1][j] >= lcs[i][j+1]:
				lcs[i][j] = lcs[i+1][j]
			default:
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && midA[i] == midB[j]:
			ops = append(ops, diffOp{' ', midA[i]})
			i++
			j++
		case i < n && (j >= m || lcs[i+1][j] >= lcs[i][j+1]):
			ops = append(ops, diffOp{'-', midA[i]})
			i++
		default:
			ops = append(ops, diffOp{'+', midB[j]})
			j++
		}
	}
	for _, l := range a[sa:] {
		ops = append(ops, diffOp{' ', l})
	}
	return ops, true
}

// unifiedHunks is the changed hunks of the diff from old to new in the unified form ("@@ -a,b +c,d @@" and the lines), with editDiffContext unchanged lines around each change. Empty when nothing changed.
// ok is false when the change is too big to compare.
func unifiedHunks(oldText, newText string) (out string, ok bool) {
	ops, ok := lineDiffOps(splitDiffLines(oldText), splitDiffLines(newText))
	if !ok {
		return "", false
	}
	// the ranges of ops to show: each change widened by the context, ranges that touch joined
	type span struct{ from, to int }
	var spans []span
	for i, op := range ops {
		if op.kind == ' ' {
			continue
		}
		from, to := max(i-editDiffContext, 0), min(i+editDiffContext+1, len(ops))
		if n := len(spans); n > 0 && from <= spans[n-1].to {
			spans[n-1].to = max(spans[n-1].to, to)
		} else {
			spans = append(spans, span{from, to})
		}
	}
	// the line numbers where each op starts (1-based) in the old and the new text
	oldAt, newAt := make([]int, len(ops)+1), make([]int, len(ops)+1)
	o, n := 1, 1
	for i, op := range ops {
		oldAt[i], newAt[i] = o, n
		if op.kind != '+' {
			o++
		}
		if op.kind != '-' {
			n++
		}
	}
	var b strings.Builder
	for _, sp := range spans {
		oldN, newN := 0, 0
		for _, op := range ops[sp.from:sp.to] {
			if op.kind != '+' {
				oldN++
			}
			if op.kind != '-' {
				newN++
			}
		}
		fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", oldAt[sp.from], oldN, newAt[sp.from], newN)
		for _, op := range ops[sp.from:sp.to] {
			b.WriteByte(op.kind)
			b.WriteString(op.text)
			b.WriteByte('\n')
		}
	}
	return strings.TrimRight(b.String(), "\n"), true
}
