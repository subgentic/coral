package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dataowner"
	"github.com/subgentic/coral/internal/store"
)

// #12591: when the ids show this database may be a copy, Coral runs as usual and the dashboard offers "This is my data folder". The press adopts the folder in place (the database's row and the
// folder's file), with no restart, and is the person's alone: an agent token and the Hub are refused. Nothing waits on it.
func TestThisIsMyDataFolderAdoptsInPlaceAndOnlyForAPerson(t *testing.T) {
	t.Cleanup(dataowner.ResetCopyWarningForTest)
	r := newWakeRig(t)
	dir, row := t.TempDir(), ""
	calls := 0
	adopt := func(ctx context.Context) error {
		calls++
		return dataowner.Adopt(ctx, dataowner.Probe{Dir: dir,
			Marker:    func(context.Context) (string, error) { return row, nil },
			SetMarker: func(_ context.Context, id string) error { row = id; return nil }})
	}
	press := func(mod func(*http.Request) *http.Request) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/system/data-folder/adopt", nil)
		req = mod(req)
		rec := httptest.NewRecorder()
		r.h.AdoptDataFolder(rec, req)
		return rec
	}
	person := func(req *http.Request) *http.Request {
		return req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}

	// nothing to answer: pressing does nothing
	var out map[string]any
	rec := press(person)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, false, out["adopted"])
	assert.Zero(t, calls)

	dataowner.SetCopyWarning(dataowner.Notice, adopt)

	// an agent's token is refused, and so is the Hub's tunnel: the warning stays and nothing is adopted
	rec = press(func(req *http.Request) *http.Request {
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "s1"}))
		req.Header.Set(store.SessionTokenHeader, "t")
		return req
	})
	assert.Equal(t, http.StatusForbidden, rec.Code, "an agent cannot press it")
	rec = press(func(req *http.Request) *http.Request { return person(stamp(req)) })
	assert.Equal(t, http.StatusForbidden, rec.Code, "the Hub cannot press it")
	assert.Zero(t, calls)
	assert.Equal(t, dataowner.Notice, dataowner.CopyWarning())
	assert.Empty(t, row)

	// the person: adopted in place, no restart, the warning gone
	rec = press(person)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, true, out["adopted"])
	assert.Equal(t, 1, calls)
	assert.Len(t, row, 32, "the database carries a new id")
	_, err := os.Stat(filepath.Join(dir, dataowner.FileName))
	assert.NoError(t, err, "and the folder has its id file")
	assert.Empty(t, dataowner.CopyWarning())

	// a second press does nothing
	rec = press(person)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, false, out["adopted"])
	assert.Equal(t, 1, calls)
}

func TestAnAdoptThatFailsKeepsTheWarningAndSaysSoPlainly(t *testing.T) {
	t.Cleanup(dataowner.ResetCopyWarningForTest)
	r := newWakeRig(t)
	dataowner.SetCopyWarning(dataowner.Notice, func(context.Context) error { return errors.New("/very/private/path: disk full") })
	req := httptest.NewRequest("POST", "/api/system/data-folder/adopt", nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rec := httptest.NewRecorder()
	r.h.AdoptDataFolder(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "/very/private/path", "the error text of the failure stays in the log")
	assert.Equal(t, dataowner.Notice, dataowner.CopyWarning(), "the warning stays: the person can press again")
}

// The system status carries the warning to the dashboard, and nothing when there is none.
func TestSystemStatusCarriesTheCopyWarning(t *testing.T) {
	t.Cleanup(dataowner.ResetCopyWarningForTest)
	h := newSystemHandlerForTest(t)
	status := func() map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		h.Status(rec, httptest.NewRequest(http.MethodGet, "/api/system/status", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	assert.Equal(t, "", status()["data_folder_warning"])
	dataowner.SetCopyWarning(dataowner.Notice, func(context.Context) error { return nil })
	assert.Equal(t, dataowner.Notice, status()["data_folder_warning"])
}
