package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/config"
)

// A dev build's coral --version names its build (walk 53, #17169): the stamp /api/health reports ("<next patch>-dev+<commit>"), not just "development build". The leading words stay, for what reads them.
func TestDevBuildVersionCarriesTheBuildStamp(t *testing.T) {
	old := config.Version
	t.Cleanup(func() { config.Version = old })
	config.Version = ""
	var b bytes.Buffer
	printVersion(&b)
	assert.True(t, strings.HasPrefix(b.String(), "coral (development build)"), b.String())
	assert.Contains(t, b.String(), config.ReportedVersion(), "the same stamp the health answer carries")
}
