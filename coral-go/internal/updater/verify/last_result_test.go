package verify

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What the file says is read back only as far as it has the shape the writer gives it (#9726): a result outside the closed set is "unknown", a field that does not validate is dropped (not the record, never the state).
func TestCheckResultIsReadBackOnlyInShape(t *testing.T) {
	ok := &CheckResult{Result: "up_to_date", Newest: "1.4.131", Stage: "manifest", At: "2026-10-28T12:00:00Z"}
	assert.Equal(t, ok, ok.Clean())
	assert.Nil(t, (*CheckResult)(nil).Clean())
	assert.Nil(t, (&CheckResult{}).Clean(), "no result, no record")
	for _, w := range []string{"up_to_date", "staged", "already_staged", "not_promoted", "failed", "rate_limited"} {
		assert.Equal(t, w, (&CheckResult{Result: w}).Clean().Result)
	}
	for _, w := range []string{"UP_TO_DATE", "<script>", "up to date", "rate-limited", "../../x", "installed", "a\nb"} {
		assert.Equal(t, "unknown", (&CheckResult{Result: w}).Clean().Result, "result %q", w)
	}
	for _, bad := range []CheckResult{
		{Result: "failed", Stage: "Manifest"}, {Result: "failed", Stage: "a b"}, {Result: "failed", Stage: "<b>"}, {Result: "failed", Stage: "x/y"},
		{Result: "failed", Newest: "v1.4.131"}, {Result: "failed", Newest: "1.4"}, {Result: "failed", Newest: "1.4.131-rc1"}, {Result: "failed", Newest: "<img src=x>"},
		{Result: "failed", At: "yesterday"}, {Result: "failed", At: "2026-10-28 12:00"},
	} {
		got := bad.Clean()
		require.NotNil(t, got, "%+v", bad)
		assert.Equal(t, "failed", got.Result)
		assert.Empty(t, got.Stage, "%+v", bad)
		assert.Empty(t, got.Newest, "%+v", bad)
		assert.Empty(t, got.At, "%+v", bad)
	}
}

func TestAStateWithAHandMadeLastResultLoadsAndShowsNothingRaw(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, StateFile), []byte(`{"version":"1.4.130","sequence":3,"revoked":[],"last_result":{"result":"<script>alert(1)</script>","newest":"9.9.9; rm -rf /","stage":"A B","at":"soon"}}`), 0o600))
	st, err := LoadState(dir)
	require.NoError(t, err, "a damaged record never makes the state corrupt")
	require.NotNil(t, st.LastResult)
	assert.Equal(t, CheckResult{Result: "unknown"}, *st.LastResult)
	require.NoError(t, os.WriteFile(filepath.Join(dir, StateFile), []byte(`{"version":"1.4.130","sequence":3,"revoked":[],"last_result":"nope"}`), 0o600))
	_, err = LoadState(dir)
	assert.Error(t, err, "a last_result of the wrong JSON type is a damaged file, as any other field of it")
}
