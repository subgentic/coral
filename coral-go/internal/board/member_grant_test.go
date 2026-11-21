package board

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	mgLink   = "lnk-aaaa1111"
	mgUser   = "hub-user-bbbb2222"
	mgSigner = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 43 characters: an owner device's key id
)

var mgNonce atomic.Int64

func memberStore(t *testing.T) *Store {
	s := testStore(t)
	_, err := s.Subscribe(context.Background(), "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	return s
}

// signed gives a grant its proof: the owner's device, a nonce used once, and the time.
func signed(g NewMemberGrant) NewMemberGrant {
	g.SignedBy = mgSigner
	g.Nonce = fmt.Sprintf("%022d", mgNonce.Add(1))
	g.Ts = time.Now().Unix()
	return g
}

func grantOf(board string) NewMemberGrant {
	return signed(NewMemberGrant{LinkID: mgLink, HubUser: mgUser, Level: MemberLevelView, ScopeKind: MemberScopeBoard, ScopeID: board, BoardID: board, Label: "Ada from Acme"})
}

func fullOf() NewMemberGrant {
	return signed(NewMemberGrant{LinkID: mgLink, HubUser: mgUser, Level: MemberLevelFull, ScopeKind: MemberScopeComputer, Label: "Ada from Acme"})
}

// #20511: a view grant is keyed by the link, the Hub person and the scope, and is read from the table on every call.
func TestAMemberGrantIsKeyedByLinkPersonAndScopeAndReadEveryTime(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	now := time.Now()
	_, err := s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeBoard, "team1", now)
	assert.ErrorIs(t, err, ErrNoMemberGrant)

	g, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	live, err := s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeBoard, "team1", now)
	require.NoError(t, err)
	assert.Equal(t, g.GrantID, live.GrantID)
	assert.Equal(t, MemberLevelView, live.Level)
	assert.Equal(t, mgSigner, live.SignedBy, "the owner's device that signed it is kept")

	for _, k := range [][4]string{{"lnk-cccc3333", mgUser, MemberScopeBoard, "team1"}, {mgLink, "hub-user-dddd4444", MemberScopeBoard, "team1"}, {mgLink, mgUser, MemberScopeBoard, "team2"},
		{mgLink, mgUser, MemberScopeAgent, "team1"}, {mgLink, mgUser, MemberScopeComputer, ""}} {
		_, err := s.MemberGrantLive(ctx, k[0], k[1], k[2], k[3], now)
		assert.ErrorIs(t, err, ErrNoMemberGrant, "%v", k)
	}

	_, err = s.RevokeMemberGrant(ctx, g.GrantID, now)
	require.NoError(t, err)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeBoard, "team1", now)
	assert.ErrorIs(t, err, ErrNoMemberGrant)
	_, err = s.RevokeMemberGrant(ctx, g.GrantID, now)
	assert.ErrorIs(t, err, ErrNoMemberGrant, "a second revoke finds nothing live")
}

func TestAMemberGrantExpires(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	in := grantOf("team1")
	in.Days = 1
	_, err := s.CreateMemberGrant(ctx, in)
	require.NoError(t, err)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeBoard, "team1", time.Now().Add(23*time.Hour))
	assert.NoError(t, err)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeBoard, "team1", time.Now().Add(25*time.Hour))
	assert.ErrorIs(t, err, ErrNoMemberGrant, "past its expiry it is not live")
}

func TestAMemberGrantIsRefusedWhenItIsNotValid(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	bad := map[string]func(*NewMemberGrant){
		"view beyond 30 days":               func(g *NewMemberGrant) { g.Days = 31 },
		"negative days":                     func(g *NewMemberGrant) { g.Days = -1 },
		"the old team level":                func(g *NewMemberGrant) { g.Level = "team" },
		"a level of owner":                  func(g *NewMemberGrant) { g.Level = "owner" },
		"a level of guide":                  func(g *NewMemberGrant) { g.Level = "guide" },
		"a board that is not there":         func(g *NewMemberGrant) { g.ScopeID, g.BoardID = "no-such-team", "no-such-team" },
		"a board name with spaces":          func(g *NewMemberGrant) { g.ScopeID, g.BoardID = " team1", " team1" },
		"a board scope naming another id":   func(g *NewMemberGrant) { g.ScopeID = "team2" },
		"no scope id":                       func(g *NewMemberGrant) { g.ScopeID = "" },
		"no scope kind":                     func(g *NewMemberGrant) { g.ScopeKind = "" },
		"the computer as a view scope":      func(g *NewMemberGrant) { g.ScopeKind, g.ScopeID, g.BoardID = MemberScopeComputer, "", "" },
		"a link that is not a link":         func(g *NewMemberGrant) { g.LinkID = "lnk-1" },
		"a person that is not one":          func(g *NewMemberGrant) { g.HubUser = "Operator" },
		"no label":                          func(g *NewMemberGrant) { g.Label = "  " },
		"the Operator's name":               func(g *NewMemberGrant) { g.Label = "Operator" },
		"no signer":                         func(g *NewMemberGrant) { g.SignedBy = "" },
		"a signer that is not a key id":     func(g *NewMemberGrant) { g.SignedBy = "Operator" },
		"no nonce":                          func(g *NewMemberGrant) { g.Nonce = "" },
		"a nonce of the wrong length":       func(g *NewMemberGrant) { g.Nonce = "abc" },
		"no time":                           func(g *NewMemberGrant) { g.Ts = 0 },
		"a files add-on with no folder":     func(g *NewMemberGrant) { g.FlagFiles = true },
		"a folder with no files add-on":     func(g *NewMemberGrant) { g.PinnedFolder = "/work" },
		"the files add-on while it is shut": func(g *NewMemberGrant) { g.FlagFiles, g.PinnedFolder = true, "/work" },
	}
	for name, f := range bad {
		in := grantOf("team1")
		f(&in)
		_, err := s.CreateMemberGrant(ctx, in)
		require.Error(t, err, name)
		assert.ErrorIs(t, err, ErrMemberGrant, name)
	}
	ls, err := s.ListMemberGrants(ctx, "", time.Now())
	require.NoError(t, err)
	assert.Empty(t, ls, "a refused grant writes no row")
}

// Full access, one agent and the files add-on are shut until a commit Security has read opens them (B8, V5, V9).
func TestFullAgentAndFilesAreShutByDefault(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	require.False(t, MemberFullOpen)
	require.False(t, MemberAgentScopeOpen)
	require.False(t, MemberFilesOpen)
	_, err := s.CreateMemberGrant(ctx, fullOf())
	assert.ErrorIs(t, err, ErrMemberGrant)
	a := grantOf("team1")
	a.ScopeKind, a.ScopeID = MemberScopeAgent, "agent-1"
	_, err = s.CreateMemberGrant(ctx, a)
	assert.ErrorIs(t, err, ErrMemberGrant)
	ls, _ := s.ListMemberGrants(ctx, "", time.Now())
	assert.Empty(t, ls)
}

func TestOnceTheGatesAreOpenFullAndAgentAndFilesFollowTheirRules(t *testing.T) {
	AllowMemberGatesForTest(t)
	s := memberStore(t)
	ctx := context.Background()

	f, err := s.CreateMemberGrant(ctx, fullOf())
	require.NoError(t, err)
	live, err := s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeComputer, "", time.Now())
	require.NoError(t, err)
	assert.Equal(t, f.GrantID, live.GrantID)
	assert.Equal(t, "", live.BoardID)

	// Full lasts at most 7 days and has no scope or add-on.
	for name, mut := range map[string]func(*NewMemberGrant){
		"8 days":          func(g *NewMemberGrant) { g.Days = 8 },
		"a team":          func(g *NewMemberGrant) { g.ScopeKind, g.ScopeID, g.BoardID = MemberScopeBoard, "team1", "team1" },
		"a scope id":      func(g *NewMemberGrant) { g.ScopeID = "x" },
		"a board":         func(g *NewMemberGrant) { g.BoardID = "team1" },
		"the artifacts":   func(g *NewMemberGrant) { g.FlagArtifacts = true },
		"the files":       func(g *NewMemberGrant) { g.FlagFiles, g.PinnedFolder = true, "/work" },
		"a pinned folder": func(g *NewMemberGrant) { g.PinnedFolder = "/work" },
	} {
		g := fullOf()
		g.HubUser = "hub-user-eeeeeeee"
		mut(&g)
		_, err := s.CreateMemberGrant(ctx, g)
		assert.ErrorIs(t, err, ErrMemberGrant, name)
	}
	v := grantOf("team1")
	v.Days = 30
	_, err = s.CreateMemberGrant(ctx, v)
	require.NoError(t, err, "a view grant may last 30 days")

	// At most MemberFullPerComputer live full grants.
	for i := 1; i < MemberFullPerComputer; i++ {
		g := fullOf()
		g.HubUser = "hub-user-" + hex8(i)
		_, err := s.CreateMemberGrant(ctx, g)
		require.NoError(t, err, i)
	}
	g := fullOf()
	g.HubUser = "hub-user-ffffffff"
	_, err = s.CreateMemberGrant(ctx, g)
	assert.ErrorIs(t, err, ErrMemberGrant, "a fourth live full grant")

	// An agent scope and a files add-on with its folder, once open.
	a := grantOf("team1")
	a.HubUser = "hub-user-aaaaaaaa"
	a.ScopeKind, a.ScopeID = MemberScopeAgent, "agent-1"
	a.FlagArtifacts, a.FlagFiles, a.PinnedFolder = true, true, "/work/app"
	ag, err := s.CreateMemberGrant(ctx, a)
	require.NoError(t, err)
	assert.True(t, ag.FlagArtifacts)
	assert.Equal(t, "/work/app", ag.PinnedFolder)
	_, err = s.MemberGrantLive(ctx, mgLink, "hub-user-aaaaaaaa", MemberScopeBoard, "agent-1", time.Now())
	assert.ErrorIs(t, err, ErrNoMemberGrant, "an agent's grant is not the board's")
}

// The nonce of a signature is spent once: the same signed grant sent again writes nothing.
func TestASignedGrantCannotBeReplayed(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	in := grantOf("team1")
	_, err := s.CreateMemberGrant(ctx, in)
	require.NoError(t, err)
	g, err := s.RevokeMemberGrantsOfLink(ctx, mgLink, time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, g)
	_, err = s.CreateMemberGrant(ctx, in)
	assert.ErrorIs(t, err, ErrMemberGrant, "the same nonce, even after the grant ended")
	ls, _ := s.ListMemberGrants(ctx, "", time.Now())
	assert.Empty(t, ls)
}

// The database refuses what the model does not allow, whatever the code above it does (B5).
func TestTheTableItselfRefusesWhatTheModelDoesNotAllow(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	nonce := func() string { return fmt.Sprintf("%022d", mgNonce.Add(1)) }
	digest := strings.Repeat("a", 64)
	ins := func(level, kind, scope, board string, art, files int, folder string) error {
		_, err := s.db.ExecContext(ctx, `INSERT INTO member_grant (grant_id, link_id, hub_user, level, scope_kind, scope_id, board_id, flag_artifacts, flag_files, pinned_folder, label, signed_by, signed_nonce, signed_digest, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'x', ?, ?, ?, 't', 't')`, "mg-"+nonce()[6:], mgLink, mgUser, level, kind, scope, board, art, files, folder, mgSigner, nonce(), digest)
		return err
	}
	require.NoError(t, ins("view", "board", "team1", "team1", 1, 0, ""), "a good view row")
	require.NoError(t, ins("full", "computer", "", "", 0, 0, ""), "a good full row")
	for name, err := range map[string]error{
		"level team":                  ins("team", "board", "team1", "team1", 0, 0, ""),
		"view with the computer":      ins("view", "computer", "", "", 0, 0, ""),
		"view with an empty scope":    ins("view", "board", "", "team1", 0, 0, ""),
		"view with no board":          ins("view", "agent", "a1", "", 0, 0, ""),
		"a board scope of another id": ins("view", "board", "team2", "team1", 0, 0, ""),
		"full with a team":            ins("full", "board", "team1", "team1", 0, 0, ""),
		"full with a scope id":        ins("full", "computer", "x", "", 0, 0, ""),
		"full with the artifacts":     ins("full", "computer", "", "", 1, 0, ""),
		"full with the files":         ins("full", "computer", "", "", 0, 1, "/w"),
		"files with no folder":        ins("view", "agent", "a1", "team1", 0, 1, ""),
		"a folder with no files":      ins("view", "agent", "a1", "team1", 0, 0, "/w"),
		"a flag of 2":                 ins("view", "agent", "a1", "team1", 2, 0, ""),
	} {
		assert.Error(t, err, name)
	}
}

// The first shape of the table never reached a release: its rows are dropped, never mapped (a team grant is not a full one).
func TestTheFirstShapeOfTheTableIsDroppedNotMapped(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	_, err := s.db.ExecContext(ctx, `DROP TABLE member_grant`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `CREATE TABLE member_grant (grant_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, hub_user TEXT NOT NULL, board_id TEXT NOT NULL, level TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT INTO member_grant VALUES ('mg-0000000000000001', ?, ?, 'team1', 'team', 'Ada', 't', '9999', NULL)`, mgLink, mgUser)
	require.NoError(t, err)
	require.NoError(t, s.ensureMemberGrantSchema(ctx))
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant`))
	assert.Zero(t, n, "the old team row is gone")
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM pragma_table_info('member_grant') WHERE name IN ('scope_kind', 'signed_nonce', 'flag_files')`))
	assert.Equal(t, 3, n, "the new shape")
	require.NoError(t, s.ensureMemberGrantSchema(ctx), "a second run leaves the new table alone")
	_, err = s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	require.NoError(t, s.ensureMemberGrantSchema(ctx))
	ls, _ := s.ListMemberGrants(ctx, "", time.Now())
	assert.Len(t, ls, 1, "the table of the new shape keeps its rows")
}

func TestMemberGrantCeilings(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	_, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	_, err = s.CreateMemberGrant(ctx, grantOf("team1"))
	assert.ErrorIs(t, err, ErrMemberGrant, "a second live grant for the same person and scope")

	for i := 2; i <= MemberGrantsPerPerson; i++ {
		b := "team" + string(rune('0'+i))
		_, err := s.Subscribe(ctx, b, "Dev", "Backend Dev", "s"+b, nil, "")
		require.NoError(t, err)
		_, err = s.CreateMemberGrant(ctx, grantOf(b))
		require.NoError(t, err, b)
	}
	_, err = s.Subscribe(ctx, "team9", "Dev", "Backend Dev", "s9", nil, "")
	require.NoError(t, err)
	_, err = s.CreateMemberGrant(ctx, grantOf("team9"))
	assert.ErrorIs(t, err, ErrMemberGrant, "a sixth scope for one person")

	s2 := memberStore(t)
	for i := 0; i < MemberGrantsPerScope; i++ {
		in := grantOf("team1")
		in.HubUser = "hub-user-" + hex8(i)
		_, err := s2.CreateMemberGrant(ctx, in)
		require.NoError(t, err, i)
	}
	in := grantOf("team1")
	in.HubUser = "hub-user-ffffffff"
	_, err = s2.CreateMemberGrant(ctx, in)
	assert.ErrorIs(t, err, ErrMemberGrant, "a twenty-first person on one team")
}

func hex8(i int) string {
	const d = "0123456789abcdef"
	b := []byte("00000000")
	for k := 7; k >= 0 && i > 0; k-- {
		b[k] = d[i%16]
		i /= 16
	}
	return string(b)
}

// What the device signs names every field: change one and the text changes, so a signature made for one grant is never another's.
func TestTheSignedTextNamesEveryField(t *testing.T) {
	base := grantOf("team1")
	base.PinnedFolder, base.FlagFiles = "/w", true
	d0 := string(MemberGrantDigest(base))
	assert.True(t, strings.HasPrefix(d0, "coral/member-grant/1\n"))
	for name, mut := range map[string]func(*NewMemberGrant){
		"link":      func(g *NewMemberGrant) { g.LinkID = "lnk-cccc3333" },
		"person":    func(g *NewMemberGrant) { g.HubUser = "hub-user-cccc3333" },
		"level":     func(g *NewMemberGrant) { g.Level = MemberLevelFull },
		"kind":      func(g *NewMemberGrant) { g.ScopeKind = MemberScopeAgent },
		"scope":     func(g *NewMemberGrant) { g.ScopeID = "other" },
		"board":     func(g *NewMemberGrant) { g.BoardID = "other" },
		"artifacts": func(g *NewMemberGrant) { g.FlagArtifacts = true },
		"files":     func(g *NewMemberGrant) { g.FlagFiles = false },
		"folder":    func(g *NewMemberGrant) { g.PinnedFolder = "/x" },
		"days":      func(g *NewMemberGrant) { g.Days = 3 },
		"nonce":     func(g *NewMemberGrant) { g.Nonce = fmt.Sprintf("%022d", 7) },
		"time":      func(g *NewMemberGrant) { g.Ts++ },
	} {
		g := base
		mut(&g)
		assert.NotEqual(t, d0, string(MemberGrantDigest(g)), name)
	}
	g := base
	g.Label, g.SignedBy = "someone else", "B"+mgSigner[1:]
	assert.Equal(t, d0, string(MemberGrantDigest(g)), "the label and the signer's id are not in it")
	g = base
	g.Days = MemberGrantDefaultDays
	assert.Equal(t, d0, string(MemberGrantDigest(g)), "days 0 and the default are the same text")
}

// The audit has no text field: nothing a person wrote is kept in it; a grant and a revoke each write one row, with the device that signed.
func TestTheMemberGrantAuditHasNoTextField(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	g, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	_, err = s.RevokeMemberGrant(ctx, g.GrantID, time.Now())
	require.NoError(t, err)
	n, err := s.MemberGrantAuditCount(ctx, g.GrantID)
	require.NoError(t, err)
	assert.Equal(t, 2, n)
	rows, err := s.db.QueryxContext(ctx, `SELECT * FROM member_grant_audit`)
	require.NoError(t, err)
	cols, _ := rows.Columns()
	rows.Close()
	assert.Equal(t, []string{"id", "at", "grant_id", "event", "link_id", "hub_user", "level", "scope_kind", "scope_id", "board_id", "signed_by"}, cols, "no label, no text, no free field")
}

func TestRemovingALinkEndsItsGrants(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	_, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	n, err := s.RevokeMemberGrantsOfLink(ctx, mgLink, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, MemberScopeBoard, "team1", time.Now())
	assert.ErrorIs(t, err, ErrNoMemberGrant)
}
