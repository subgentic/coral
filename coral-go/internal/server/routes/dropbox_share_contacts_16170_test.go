package routes

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (be *backupEnv) contacts(q string) []string {
	be.t.Helper()
	code, out := be.shareCall(http.MethodGet, "/api/dropbox/share-contacts?q="+q, "", callerDashCookie)
	require.Equal(be.t, http.StatusOK, code, "%v", out)
	var got []string
	for _, e := range out["emails"].([]any) {
		got = append(got, e.(string))
	}
	return got
}

// #16170: the dialog suggests the addresses this Coral already shared to, then the people in the account's shared folders (Dropbox has no call that lists contacts): newest share first,
// folder members after, no address twice, at most eight, only what contains what was typed.
func TestTheShareDialogSuggestsAddressesAlreadySharedToAndFolderMembers(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	assert.Empty(t, be.contacts(""), "nothing known yet")
	code, out := be.share(d, `{"name":"x.md","audience":"people","emails":["Ana@Example.com","sam@example.com"],"confirm":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)

	be.dbx.folders = map[string][]string{"f1": {"lee@work.org", "ana@example.com", "pat@work.org"}}
	be.b.contactsAt, be.dbx.folderCalls = time.Time{}, 0 // the empty read above was kept; the folders are new
	assert.ElementsMatch(t, []string{"ana@example.com", "sam@example.com", "lee@work.org", "pat@work.org"}, be.contacts(""))
	assert.Equal(t, []string{"ana@example.com"}, be.contacts("AN"), "a substring, any case, once")
	assert.Equal(t, []string{"lee@work.org", "pat@work.org"}, be.contacts("work"), "folder members count too")
	assert.Equal(t, 1, be.dbx.folderCalls, "the folders are read once, then kept five minutes")

	// A share that failed is not remembered.
	be.dbx.membersFail = true
	be.share(d, `{"name":"y.md","audience":"people","emails":["fail@example.com"],"confirm":true}`)
	assert.Empty(t, be.contacts("fail"))
}

// Dropbox that cannot be read, or an older sign-in without sharing.read, still gives the addresses kept here; no more than eight come back.
func TestSuggestionsSurviveADropboxThatCannotBeRead(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	require.Equal(t, http.StatusOK, mustCode(be.share(d, `{"name":"x.md","audience":"people","emails":["ana@example.com"],"confirm":true}`)))
	be.dbx.noScope = true
	assert.Equal(t, []string{"ana@example.com"}, be.contacts(""))
	be.dbx.noScope = false
	many := map[string][]string{"f": {}}
	for i := 0; i < 30; i++ {
		many["f"] = append(many["f"], string(rune('a'+i%26))+string(rune('a'+i/26))+"@x.org")
	}
	be.dbx.folders = many
	be.b.contactsAt = time.Time{}
	assert.Len(t, be.contacts(""), 8)
}

func mustCode(code int, _ map[string]any) int { return code }

// Only the person at this computer's dashboard gets any: an agent, the Hub (its owner too), an API key or a local script is refused.
func TestSuggestionsAreForTheOperatorsDashboardOnly(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	require.Equal(t, http.StatusOK, mustCode(be.share(d, `{"name":"x.md","audience":"people","emails":["ana@example.com"],"confirm":true}`)))
	for _, kind := range []string{"", callerHub, callerHubOwner, callerAgentToken, callerAPIKey, callerLocalOther} {
		code, out := be.shareCall(http.MethodGet, "/api/dropbox/share-contacts?q=", "", kind)
		assert.Equal(t, http.StatusForbidden, code, "caller %q", kind)
		assert.Nil(t, out["emails"], "caller %q", kind)
	}
}

// The remembered addresses are the old account's when the account goes: forgetting the shares clears them, and the newest hundred only are kept.
func TestRememberedAddressesGoWithTheAccountAndAreCapped(t *testing.T) {
	be, _ := newDropboxShareEnv(t)
	ctx := context.Background()
	now := time.Now()
	for i := 0; i < 130; i++ {
		e := []string{string(rune('a'+i%26)) + string(rune('a'+i/26%26)) + string(rune('a'+i/676)) + "@x.org"}
		require.NoError(t, be.b.outbox.RememberShareContacts(ctx, "acct", e, now.Add(time.Duration(i)*time.Second)))
	}
	all, err := be.b.outbox.ShareContacts(ctx, "acct", "", 500)
	require.NoError(t, err)
	assert.Len(t, all, 100)
	other, _ := be.b.outbox.ShareContacts(ctx, "other", "", 500)
	assert.Empty(t, other, "per account")
	_, err = be.b.outbox.ForgetShares(ctx)
	require.NoError(t, err)
	all, _ = be.b.outbox.ShareContacts(ctx, "acct", "", 500)
	assert.Empty(t, all)
}

// Security's SHOULD on #16170: a Dropbox that is down or rate-limited is asked once per 30 s, not on every keystroke, and the lock is not held across the call.
func TestAFailedFolderReadIsKeptThirtySecondsAndNeverHoldsTheLock(t *testing.T) {
	be, d := newDropboxShareEnv(t)
	require.Equal(t, http.StatusOK, mustCode(be.share(d, `{"name":"x.md","audience":"people","emails":["ana@example.com"],"confirm":true}`)))
	now := time.Now()
	be.b.now = func() time.Time { return now }
	be.dbx.foldersFail, be.dbx.folderCalls = true, 0
	for _, q := range []string{"", "a", "an", "ana"} {
		assert.Equal(t, []string{"ana@example.com"}, be.contacts(q), "the kept addresses still come back")
	}
	assert.Equal(t, 1, be.dbx.folderCalls, "four keystrokes, one Dropbox call")
	now = now.Add(29 * time.Second)
	be.contacts("")
	assert.Equal(t, 1, be.dbx.folderCalls, "still kept at 29 s")
	now = now.Add(2 * time.Second)
	be.dbx.foldersFail, be.dbx.folders = false, map[string][]string{"f1": {"lee@work.org"}}
	assert.ElementsMatch(t, []string{"ana@example.com", "lee@work.org"}, be.contacts(""), "asked again after 30 s, and the good read is kept")
	assert.Equal(t, 2, be.dbx.folderCalls)

	// The lock is free while a read is under way: a keystroke during it is answered at once from what is kept.
	be.b.forgetContacts()
	be.b.contactsMu.Lock()
	be.b.contactsBusy = true
	be.b.contactsMu.Unlock()
	done := make(chan []string, 1)
	go func() { done <- be.contacts("") }()
	select {
	case got := <-done:
		assert.Equal(t, []string{"ana@example.com"}, got)
	case <-time.After(5 * time.Second):
		t.Fatal("a keystroke waited for a read that was under way")
	}
}

// Security's INFO on #16170: Disconnect, Switch and Rekey empty the folder-member cache with the remembered addresses.
func TestForgettingTheSharesEmptiesTheFolderMemberCache(t *testing.T) {
	be, _ := newDropboxShareEnv(t)
	be.dbx.folders = map[string][]string{"f1": {"lee@work.org"}}
	assert.Equal(t, []string{"lee@work.org"}, be.contacts(""))
	require.NotEmpty(t, be.b.contactsList)
	(&dropboxRoutes{backup: be.b}).forgetShares(context.Background())
	be.b.contactsMu.Lock()
	assert.Empty(t, be.b.contactsList)
	assert.Empty(t, be.b.contactsFor)
	be.b.contactsMu.Unlock()
}
