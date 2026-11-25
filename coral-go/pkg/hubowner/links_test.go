package hubowner

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21213: one secret per hub link, so a second hub's install never replaces the first's.

const (
	linkHubA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	linkHubB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func TestASecondHubsInstallKeepsTheFirstHubsSecret(t *testing.T) {
	dir := t.TempDir()
	a, b := strings.Repeat("1a", 32), strings.Repeat("2b", 32)
	require.NoError(t, Install(dir, Link{Hub: linkHubA, Name: "Studio hub", Remote: "mac", Secret: a}, time.Now()))
	require.NoError(t, Install(dir, Link{Hub: linkHubB, Name: "Laptop hub", Remote: "mac", Secret: b}, time.Now()))
	ls, err := Links(dir)
	require.NoError(t, err)
	require.Len(t, ls, 2)
	assert.Equal(t, a, ls[0].Secret)
	assert.Equal(t, b, ls[1].Secret)

	// a hub's second install replaces only its own
	c := strings.Repeat("3c", 32)
	require.NoError(t, Install(dir, Link{Hub: linkHubA, Remote: "mac", Secret: c}, time.Now()))
	ls, err = Links(dir)
	require.NoError(t, err)
	require.Len(t, ls, 2)
	got := map[string]string{ls[0].Hub: ls[0].Secret, ls[1].Hub: ls[1].Secret}
	assert.Equal(t, map[string]string{linkHubA: c, linkHubB: b}, got)

	if runtime.GOOS != "windows" {
		fi, err := os.Lstat(filepath.Join(dir, LinksFileName))
		require.NoError(t, err)
		assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	}
}

// The single file an older hub wrote stays that hub's link: an upgrade reads it as a link with no hub id, and an install without a hub id still replaces only it.
func TestTheSingleFileIsReadAsALinkAndAnOlderHubsInstallReplacesOnlyIt(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, WriteFile(dir, "ssh-box", strings.Repeat("ab", 32)))
	require.NoError(t, Install(dir, Link{Hub: linkHubA, Remote: "mac", Secret: strings.Repeat("1a", 32)}, time.Now()))
	require.NoError(t, Install(dir, Link{Remote: "ssh-box", Secret: strings.Repeat("cd", 32)}, time.Now()))
	ls, err := Links(dir)
	require.NoError(t, err)
	require.Len(t, ls, 2)
	assert.Equal(t, Link{Remote: "ssh-box", Secret: strings.Repeat("cd", 32), At: ls[0].At}, ls[0])
	assert.Equal(t, linkHubA, ls[1].Hub)
	assert.True(t, Installed(dir))
}

func TestRemoveDropsOneLinkByItsHubIDOrTheSingleFileByItsComputerID(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, WriteFile(dir, "ssh-box", strings.Repeat("ab", 32)))
	require.NoError(t, Install(dir, Link{Hub: linkHubA, Remote: "mac", Secret: strings.Repeat("1a", 32)}, time.Now()))
	require.NoError(t, Install(dir, Link{Hub: linkHubB, Remote: "mac", Secret: strings.Repeat("2b", 32)}, time.Now()))

	n, err := Remove(dir, "nobody-here")
	require.NoError(t, err)
	assert.Zero(t, n)
	n, err = Remove(dir, linkHubA)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	n, err = Remove(dir, "ssh-box")
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	ls, err := Links(dir)
	require.NoError(t, err)
	require.Len(t, ls, 1)
	assert.Equal(t, linkHubB, ls[0].Hub)
	n, err = Remove(dir, linkHubB)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	assert.False(t, Installed(dir))
	_, err = os.Lstat(filepath.Join(dir, LinksFileName))
	assert.True(t, os.IsNotExist(err), "the last link's removal takes the file")
}

func TestInstallRefusesWhatIsNotAHubLinkAndBoundsTheCount(t *testing.T) {
	dir := t.TempDir()
	s := strings.Repeat("ab", 32)
	for name, l := range map[string]Link{
		"short hub id": {Hub: "abc", Remote: "mac", Secret: s},
		"upper case":   {Hub: strings.ToUpper(linkHubA), Remote: "mac", Secret: s},
		"bad remote":   {Hub: linkHubA, Remote: "Mac Book", Secret: s},
		"bad secret":   {Hub: linkHubA, Remote: "mac", Secret: "short"},
	} {
		assert.Error(t, Install(dir, l, time.Now()), name)
	}
	for i := 0; i < MaxLinks; i++ {
		require.NoError(t, Install(dir, Link{Hub: strings.Repeat(string(rune('a'+i)), 32), Remote: "mac", Secret: s}, time.Now()))
	}
	assert.Error(t, Install(dir, Link{Hub: strings.Repeat("9", 32), Remote: "mac", Secret: s}, time.Now()), "a 17th hub")
	assert.NoError(t, Install(dir, Link{Hub: strings.Repeat("a", 32), Remote: "mac", Secret: s}, time.Now()), "a known hub's rotation")
}

func TestAHubsNameIsCleanedForAPerson(t *testing.T) {
	assert.Equal(t, "Studio hub", CleanHubName("  Studio hub \n"))
	assert.Equal(t, "evil", CleanHubName("ev\u202eil\u200b\x1b"), "no direction marks, zero-width or control characters")
	assert.Equal(t, 64, len([]rune(CleanHubName(strings.Repeat("x", 200)))))
	assert.Equal(t, "", CleanHubName("\xff\xfe"))
}

func TestAHubsLinkIDIsMadeOnceAndKept(t *testing.T) {
	dir := t.TempDir()
	id, err := HubID(dir)
	require.NoError(t, err)
	assert.True(t, ValidHubID(id), id)
	again, err := HubID(dir)
	require.NoError(t, err)
	assert.Equal(t, id, again)
	other, err := HubID(t.TempDir())
	require.NoError(t, err)
	assert.NotEqual(t, id, other)
}

// A links file that is not what Install writes refuses every stamp (Links errs), as an unusable single file always did.
func TestALinksFileThatIsNotAListOfHubSecretsIsAnError(t *testing.T) {
	for name, content := range map[string]string{
		"not json":     "hello",
		"extra field":  `[{"hub":"` + linkHubA + `","remote":"mac","secret":"` + strings.Repeat("ab", 32) + `","at":"","admin":true}]`,
		"bad secret":   `[{"hub":"` + linkHubA + `","remote":"mac","secret":"x","at":""}]`,
		"the same hub": `[{"hub":"` + linkHubA + `","remote":"mac","secret":"` + strings.Repeat("ab", 32) + `","at":""},{"hub":"` + linkHubA + `","remote":"b","secret":"` + strings.Repeat("cd", 32) + `","at":""}]`,
	} {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, LinksFileName), []byte(content), 0o600))
		_, err := Links(dir)
		assert.Error(t, err, name)
		assert.False(t, Installed(dir), name)
	}
}

func TestLinkVerifiersPickTheHubsOwnSecretAndSayWhy(t *testing.T) {
	a, b := strings.Repeat("1a", 32), strings.Repeat("2b", 32)
	links := []Link{{Hub: linkHubA, Remote: "mac", Secret: a, Name: "A"}, {Hub: linkHubB, Remote: "mac", Secret: b, Name: "B"}}
	route := "/api/board/team/artifacts/abc/review"
	lv := &LinkVerifiers{Start: time.Now().Add(-time.Hour)}
	sign := func(secret string, at time.Time) string {
		s, err := Sign(secret, "mac", "POST", route, nil, at)
		require.NoError(t, err)
		return s
	}
	l, reason, _ := lv.Check(links, linkHubB, sign(b, time.Now()), "POST", route, route, nil)
	require.Empty(t, reason)
	assert.Equal(t, "B", l.Name)
	_, reason, one := lv.Check(links, linkHubB, sign(a, time.Now()), "POST", route, route, nil)
	assert.Equal(t, ReasonWrongSecret, reason)
	require.NotNil(t, one)
	assert.Equal(t, "B", one.Name, "checked against B's only, though A's would have verified")
	_, reason, one = lv.Check(links, "", sign(a, time.Now().Add(-time.Hour)), "POST", route, route, nil)
	assert.Equal(t, ReasonStale, reason)
	assert.Nil(t, one, "several candidates: no one hub to name")
	_, reason, _ = lv.Check(nil, linkHubA, sign(a, time.Now()), "POST", route, route, nil)
	assert.Equal(t, ReasonNoSecret, reason)
}
