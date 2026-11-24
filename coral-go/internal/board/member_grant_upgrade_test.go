package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A folder from v2.1.7 has the member_grant table without via_hub and revoked_by (#20914): the migration adds both, keeps the row, and a second run changes nothing.
func TestAV217MemberGrantTableGetsTheNoticeColumnsAndKeepsItsRows(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	_, err := s.db.ExecContext(ctx, `DROP TABLE member_grant`)
	require.NoError(t, err)
	// v2.1.7's CREATE TABLE, as it was released.
	_, err = s.db.ExecContext(ctx, `CREATE TABLE member_grant (
			grant_id       TEXT PRIMARY KEY,
			link_id        TEXT NOT NULL,
			hub_user       TEXT NOT NULL,
			level          TEXT NOT NULL CHECK (level IN ('view', 'full')),
			scope_kind     TEXT NOT NULL CHECK (scope_kind IN ('board', 'agent', 'computer')),
			scope_id       TEXT NOT NULL,
			board_id       TEXT NOT NULL,
			flag_artifacts INTEGER NOT NULL DEFAULT 0 CHECK (flag_artifacts IN (0, 1)),
			flag_files     INTEGER NOT NULL DEFAULT 0 CHECK (flag_files IN (0, 1)),
			pinned_folder  TEXT NOT NULL DEFAULT '',
			label          TEXT NOT NULL,
			signed_by      TEXT NOT NULL CHECK (length(signed_by) = 43),
			signed_nonce   TEXT NOT NULL UNIQUE CHECK (length(signed_nonce) = 22),
			signed_digest  TEXT NOT NULL CHECK (length(signed_digest) = 64),
			created_at     TEXT NOT NULL,
			expires_at     TEXT NOT NULL,
			revoked_at     TEXT,
			CHECK (
				(level = 'view' AND scope_kind IN ('board', 'agent') AND scope_id <> '' AND board_id <> '' AND (scope_kind <> 'board' OR scope_id = board_id))
				OR (level = 'full' AND scope_kind = 'computer' AND scope_id = '' AND board_id = '' AND flag_artifacts = 0 AND flag_files = 0)
			),
			CHECK (flag_files = 0 OR pinned_folder <> ''),
			CHECK (pinned_folder = '' OR flag_files = 1)
		)`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT INTO member_grant (grant_id, link_id, hub_user, level, scope_kind, scope_id, board_id, label, signed_by, signed_nonce, signed_digest, created_at, expires_at) VALUES ('mg-0000000000000001', ?, ?, 'view', 'board', 'team1', 'team1', 'Ada', ?, ?, ?, '2026-11-01T00:00:00Z', '2999-01-01T00:00:00Z')`, mgLink, mgUser, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
	require.NoError(t, err)
	require.NoError(t, s.ensureMemberGrantSchema(ctx))
	require.NoError(t, s.ensureMemberGrantSchema(ctx), "a second run leaves the table alone")
	ls, err := s.ListMemberGrants(ctx, "", time.Now())
	require.NoError(t, err)
	require.Len(t, ls, 1, "the v2.1.7 row survives")
	assert.False(t, ls[0].ViaHub, "a grant made before the feed was made here")
	assert.Empty(t, ls[0].RevokedBy)
	_, err = s.RevokeMemberGrantBy(ctx, "mg-0000000000000001", time.Now(), MemberRevokedHere)
	require.NoError(t, err)
	g, err := s.MemberGrantByID(ctx, "mg-0000000000000001")
	require.NoError(t, err)
	assert.Equal(t, MemberRevokedHere, g.RevokedBy)
	n, err := s.MemberGrantNotices(ctx, time.Now().Add(-100*24*time.Hour), time.Now(), false, 10)
	require.NoError(t, err)
	assert.Len(t, n, 1, "the feed lists it")
}
