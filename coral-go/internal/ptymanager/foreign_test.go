package ptymanager

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Task #429: a Coral that does not own its database's data folder types nothing by itself.
func TestAForeignCoralTypesNothingThroughTheTwoAutomatedSenders(t *testing.T) {
	SetForeign(true)
	t.Cleanup(func() { SetForeign(false) })
	sent := 0
	send := func(context.Context) error { sent++; return nil }

	d, err := DeliverAutomated(context.Background(), AutomatedInput{Name: "claude-x", Text: "hello", What: "board message", Send: send})
	assert.ErrorIs(t, err, ErrForeign)
	assert.Equal(t, Skipped, d)

	err = AutoAcceptSend(context.Background(), "claude-x", send)
	assert.ErrorIs(t, err, ErrForeign)
	assert.Zero(t, sent, "neither send function ran")

	SetForeign(false)
	require.NoError(t, AutoAcceptSend(context.Background(), "claude-x", send))
	assert.Equal(t, 1, sent, "once the Coral is not foreign the exemption sends as before")
}

func TestTheForeignFlagReadsBack(t *testing.T) {
	assert.False(t, Foreign())
	SetForeign(true)
	assert.True(t, Foreign())
	assert.ErrorIs(t, RefuseIfForeign(), ErrForeign)
	assert.Equal(t, "this Coral does not own this data folder", ErrForeign.Error(), "a fixed reason")
	SetForeign(false)
	assert.NoError(t, RefuseIfForeign())
}

// The census of the one gate (Security's one-gate rule): the automated senders ask RefuseIfForeign first, before anything else in their body. A new automated entry point is listed here.
func TestTheAutomatedSendersAskTheForeignGateFirst(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "automated_input_deliver.go", nil, 0)
	require.NoError(t, err)
	gated := map[string]bool{"DeliverAutomated": false, "AutoAcceptSend": false}
	for _, d := range file.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		if _, listed := gated[fn.Name.Name]; !listed || len(fn.Body.List) == 0 {
			continue
		}
		first, ok := fn.Body.List[0].(*ast.IfStmt)
		if !ok {
			continue
		}
		init, ok := first.Init.(*ast.AssignStmt)
		if !ok || len(init.Rhs) != 1 {
			continue
		}
		call, ok := init.Rhs[0].(*ast.CallExpr)
		if id, isID := call.Fun.(*ast.Ident); ok && isID && id.Name == "RefuseIfForeign" {
			gated[fn.Name.Name] = true
		}
	}
	for name, ok := range gated {
		assert.True(t, ok, "%s must start with the RefuseIfForeign gate", name)
	}
}
