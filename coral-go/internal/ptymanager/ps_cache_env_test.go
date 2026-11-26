package ptymanager

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPSModuleCacheEnv(t *testing.T) {
	cache := func(base string) []string {
		return []string{"PSModuleAnalysisCachePath=" + filepath.Join(base, "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache")}
	}
	assert.Equal(t, cache("L"), psModuleCacheEnv([]string{"PATH=x", "LOCALAPPDATA=L"}, "D"), "under LOCALAPPDATA")
	assert.Equal(t, cache("L"), psModuleCacheEnv([]string{"LocalAppData=L"}, "D"), "names are compared without case")
	assert.Equal(t, cache("D"), psModuleCacheEnv([]string{"PATH=x"}, "D"), "no LOCALAPPDATA: Coral's data folder")
	assert.Equal(t, cache("D"), psModuleCacheEnv([]string{"LOCALAPPDATA="}, "D"), "an empty LOCALAPPDATA too")
	assert.Nil(t, psModuleCacheEnv([]string{"LOCALAPPDATA=L", "pSModuleAnalysisCachePath=C:\\mine"}, "D"), "a value already set is kept")
	assert.Equal(t, cache("L"), psModuleCacheEnv([]string{"LOCALAPPDATA=L", "PSModuleAnalysisCachePath="}, "D"), "an empty one is not a setting")
	assert.Nil(t, psModuleCacheEnv(nil, ""), "nowhere to put it: leave PowerShell alone")
}
