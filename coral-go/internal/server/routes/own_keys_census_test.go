package routes

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Coral's own keys to an agent (auto-accept's answer, and any other automated key) are typed only after the same gate as a notice: automatedInputBlocked (the terminal is running the
// agent, and nothing the agent started reads the terminal). Text goes through ptymanager.DeliverAutomated, which asks the terminal itself whether text may go. A function here that types
// an automated key fails this census until it asks the gate in the same function.
func TestEveryAutomatedKeyAsksTheGateFirst(t *testing.T) {
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)
	gates := map[string]bool{"automatedInputBlocked": true, "noticeWouldHold": true}
	var missing []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		af, err := parser.ParseFile(token.NewFileSet(), f, nil, 0)
		require.NoError(t, err)
		for _, d := range af.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			types, asks := false, false
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				c, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name := ""
				switch fn := c.Fun.(type) {
				case *ast.SelectorExpr:
					name = fn.Sel.Name
				case *ast.Ident:
					name = fn.Name
				}
				if gates[name] {
					asks = true
				}
				if name == "AutoAcceptSend" {
					types = true
				}
				if name == "SendRawInput" && len(c.Args) > 1 {
					if sel, ok := c.Args[1].(*ast.SelectorExpr); ok && sel.Sel.Name == "Internal" { // Coral's own key (a person's is Person or Unclassified)
						types = true
					}
				}
				return true
			})
			if types && !asks {
				missing = append(missing, f+" "+fd.Name.Name)
			}
		}
	}
	assert.Empty(t, missing, "types an automated key without asking automatedInputBlocked (or noticeWouldHold) first")
}
