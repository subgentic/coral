//go:build windows

package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestTheUpdaterSearchesOnlyTheSystemFolderForDLLs(t *testing.T) {
	assert.True(t, dllSearchLocked, "SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) took effect in init")
}
