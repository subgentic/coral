package store

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/skills"
)

func skillStore(t *testing.T) (context.Context, *SessionStore, *DB) {
	t.Helper()
	ctx := context.Background()
	db, err := OpenWithKey(ctx, filepath.Join(t.TempDir(), "skills.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	return ctx, NewSessionStore(db), db
}

func skillOf(name, desc, body string, files ...skills.File) *skills.Skill {
	return &skills.Skill{Name: name, Description: desc, Body: body, Metadata: map[string]string{"tags": "release, changelog"},
		Files: append([]skills.File{{Path: "SKILL.md", Size: 10, Kind: skills.KindInstructions, SHA256: strings.Repeat("a", 64)}}, files...)}
}

// addSkill and approveSkill bind the skill to the digest being given (as a parsed zip is), unless the test set one itself.
func addSkill(ctx context.Context, ss *SessionStore, in AddSkillInput) (*SkillRow, bool, error) {
	if in.Skill != nil && in.Skill.Digest == "" {
		in.Skill.Digest = in.Digest
	}
	return ss.AddSkill(ctx, in)
}

func approveSkill(ctx context.Context, ss *SessionStore, id, digest string, ack bool, sk *skills.Skill) error {
	if sk != nil && sk.Digest == "" {
		sk.Digest = digest
	}
	return ss.ApproveSkill(ctx, id, digest, ack, sk)
}

func dg(n int) string { return fmt.Sprintf("%064x", n) }

var script = skills.File{Path: "scripts/run.sh", Size: 5, Kind: skills.KindScript, SHA256: strings.Repeat("b", 64)}

func TestAnOperatorsSkillIsApprovedAtOnceAndSearchable(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	row, created, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("release-notes", "Writes release notes from merged PRs.", "List the merged pull requests since the tag."), Digest: dg(1), Kind: PublisherOperator})
	require.NoError(t, err)
	require.True(t, created)
	assert.Equal(t, SkillApproved, row.Status)
	assert.Equal(t, 1, row.Version)
	got, err := ss.GetApprovedSkill(ctx, row.ID)
	require.NoError(t, err)
	assert.Equal(t, dg(1), got.Digest)
	hits, err := ss.SearchSkills(ctx, "release notes", 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	assert.Equal(t, "release-notes", hits[0].Name)
	// the same name and digest again is the same row
	again, created, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("release-notes", "x", "y"), Digest: dg(1), Kind: PublisherOperator})
	require.NoError(t, err)
	assert.False(t, created)
	assert.Equal(t, row.ID, again.ID)
}

func TestAnAgentsSkillWaitsAndNobodyElseCanSeeIt(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	row, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("db-review", "Checks a SQL migration for locks.", "Look for ALTER TABLE."), Digest: dg(2), Kind: PublisherAgent, Agent: "Backend Dev", Team: "alpha"})
	require.NoError(t, err)
	assert.Equal(t, SkillPending, row.Status)
	assert.Equal(t, "Backend Dev", row.PublisherAgent)
	assert.Equal(t, "alpha", row.PublisherTeam)
	_, err = ss.GetApprovedSkill(ctx, row.ID)
	assert.ErrorIs(t, err, ErrSkillNotFound, "a pending skill is not served")
	hits, err := ss.SearchSkills(ctx, "migration", 10)
	require.NoError(t, err)
	assert.Empty(t, hits, "a pending skill is not searchable")
	pending, err := ss.ListSkills(ctx, SkillPending)
	require.NoError(t, err)
	assert.Len(t, pending, 1, "the Operator sees it")
	// reject: still not served, and the same answer as for a skill that does not exist
	require.NoError(t, ss.RejectSkill(ctx, row.ID))
	_, err = ss.GetApprovedSkill(ctx, row.ID)
	assert.ErrorIs(t, err, ErrSkillNotFound)
	_, err = ss.GetApprovedSkill(ctx, "00000000000000000000000000000000")
	assert.ErrorIs(t, err, ErrSkillNotFound)
}

func TestAnAgentCannotPublishScriptsOrFilesThatCannotBeShown(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	for name, f := range map[string]skills.File{"script": script, "binary": {Path: "assets/x.png", Size: 4, Kind: skills.KindNotReviewable, SHA256: strings.Repeat("c", 64)}} {
		_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("with-"+name, "d", "b", f), Digest: dg(3), Kind: PublisherAgent, Agent: "Dev"})
		assert.ErrorIs(t, err, ErrAgentScripts, name)
	}
	// an Operator's own needs the second click
	_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("scripted", "d", "b", script), Digest: dg(4), Kind: PublisherOperator})
	assert.ErrorIs(t, err, ErrNeedScriptsAck)
	row, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("scripted", "d", "b", script), Digest: dg(4), Kind: PublisherOperator, ScriptsAcked: true})
	require.NoError(t, err)
	assert.True(t, row.HasScripts)
	assert.True(t, row.ScriptsAcked)
}

func TestApprovalIsOnTheDigestAndAScriptedSkillNeedsTheSecondClick(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	sk := skillOf("db-review", "Checks a SQL migration.", "Look for ALTER TABLE.")
	row, _, err := addSkill(ctx, ss, AddSkillInput{Skill: sk, Digest: dg(5), Kind: PublisherAgent, Agent: "Dev"})
	require.NoError(t, err)
	assert.ErrorIs(t, approveSkill(ctx, ss, row.ID, dg(6), false, sk), ErrSkillDigest, "not the digest the Operator was shown")
	assert.ErrorIs(t, approveSkill(ctx, ss, "nope", dg(5), false, sk), ErrSkillNotFound)
	require.NoError(t, approveSkill(ctx, ss, row.ID, dg(5), false, sk))
	assert.ErrorIs(t, approveSkill(ctx, ss, row.ID, dg(5), false, sk), ErrSkillState, "already decided")
	hits, _ := ss.SearchSkills(ctx, "migration", 10)
	assert.Len(t, hits, 1, "approved: searchable")
	// a row with scripts can exist as pending only through the Operator's own path today; force one to pin the second click
	_, err = ss.db.ExecContext(ctx, `INSERT INTO skills (id, name, version, digest, status, publisher_kind, has_scripts, created_at) VALUES ('s1', 'scr', 1, ?, 'pending', 'operator', 1, 'now')`, dg(7))
	require.NoError(t, err)
	scr := skillOf("scr", "d", "b", script)
	assert.ErrorIs(t, approveSkill(ctx, ss, "s1", dg(7), false, scr), ErrNeedScriptsAck)
	require.NoError(t, approveSkill(ctx, ss, "s1", dg(7), true, scr))
}

func TestANewAgentVersionOfAnApprovedSkillWaitsAndTheOldOneStaysLive(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	v1, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("notes", "Release notes v1.", "b"), Digest: dg(8), Kind: PublisherOperator})
	require.NoError(t, err)
	v2, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("notes", "Release notes v2 changed.", "b"), Digest: dg(9), Kind: PublisherAgent, Agent: "Dev"})
	require.NoError(t, err)
	assert.Equal(t, 2, v2.Version)
	assert.Equal(t, SkillPending, v2.Status)
	latest, err := ss.LatestApprovedSkill(ctx, "notes")
	require.NoError(t, err)
	assert.Equal(t, v1.ID, latest.ID, "the approved version stays the live one")
}

func TestPendingSkillsAreCappedPerAgentAndPerComputer(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	for i := 0; i < MaxPendingPerAgent; i++ {
		_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf(fmt.Sprintf("a-%d", i), "d", "b"), Digest: dg(100 + i), Kind: PublisherAgent, Agent: "Dev"})
		require.NoError(t, err)
	}
	_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("a-extra", "d", "b"), Digest: dg(200), Kind: PublisherAgent, Agent: "Dev"})
	assert.ErrorIs(t, err, ErrPendingCap, "one agent cannot bury the Operator's list")
	n := MaxPendingPerAgent
	for agent := 0; n < MaxPendingPerComputer; agent++ {
		for i := 0; i < MaxPendingPerAgent && n < MaxPendingPerComputer; i++ {
			_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf(fmt.Sprintf("b%d-%d", agent, i), "d", "b"), Digest: dg(1000 + n), Kind: PublisherAgent, Agent: fmt.Sprintf("Agent %d", agent)})
			require.NoError(t, err)
			n++
		}
	}
	_, _, err = addSkill(ctx, ss, AddSkillInput{Skill: skillOf("late", "d", "b"), Digest: dg(300), Kind: PublisherAgent, Agent: "Someone else"})
	assert.ErrorIs(t, err, ErrPendingCap, "20 wait in all")
	// the Operator's own skill is not held back by the queue
	_, _, err = addSkill(ctx, ss, AddSkillInput{Skill: skillOf("operators", "d", "b"), Digest: dg(301), Kind: PublisherOperator})
	assert.NoError(t, err)
}

func TestARemovedSkillLeavesATombstoneAndNoText(t *testing.T) {
	ctx, ss, db := skillStore(t)
	row, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("gone", "Searchable words here.", "body text"), Digest: dg(11), Kind: PublisherOperator})
	require.NoError(t, err)
	require.NoError(t, ss.RemoveSkill(ctx, row.ID))
	_, err = ss.GetApprovedSkill(ctx, row.ID)
	assert.ErrorIs(t, err, ErrSkillRemoved, "a pinned agent is told it was removed")
	hits, _ := ss.SearchSkills(ctx, "searchable", 10)
	assert.Empty(t, hits)
	var n int
	require.NoError(t, db.GetContext(ctx, &n, `SELECT COUNT(*) FROM skills_fts WHERE skill_id = ?`, row.ID))
	assert.Zero(t, n)
	tomb, err := ss.GetSkill(ctx, row.ID)
	require.NoError(t, err)
	assert.Empty(t, tomb.Description)
	assert.Equal(t, "[]", tomb.FilesJSON)
	// the same bytes can be published again: a new version
	again, created, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("gone", "Searchable words here.", "body text"), Digest: dg(11), Kind: PublisherOperator})
	require.NoError(t, err)
	assert.True(t, created)
	assert.Equal(t, 2, again.Version)
}

func TestSkillSearchQuotesEveryWordAndRanksTheDescriptionFirst(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("pdf-forms", "Fill and flatten PDF forms.", "Nothing about invoices here."), Digest: dg(21), Kind: PublisherOperator})
	require.NoError(t, err)
	_, _, err = addSkill(ctx, ss, AddSkillInput{Skill: skillOf("accounting", "Keeps the books.", "Useful when you must fill in a PDF form for invoices."), Digest: dg(22), Kind: PublisherOperator})
	require.NoError(t, err)
	hits, err := ss.SearchSkills(ctx, "fill pdf", 10)
	require.NoError(t, err)
	require.Len(t, hits, 2)
	assert.Equal(t, "pdf-forms", hits[0].Name, "a match in the description outranks one in the text")
	// FTS5 syntax is not the asker's: operators, columns, NEAR, prefixes and quotes are words, not syntax
	for _, q := range []string{`pdf OR accounting`, `name:accounting`, `NEAR(pdf form)`, `acc*`, `"pdf" "`, `pdf AND NOT forms`, `)(`, ``, `   `} {
		_, err := ss.SearchSkills(ctx, q, 10)
		assert.NoError(t, err, q)
	}
	hits, _ = ss.SearchSkills(ctx, `pdf OR accounting`, 10)
	assert.Empty(t, hits, "OR is a word that is in no skill, not an operator")
	hits, _ = ss.SearchSkills(ctx, `acc*`, 10)
	assert.Empty(t, hits, "no prefix search")
	assert.Equal(t, `"a" "b" "c" "d" "e" "f" "g" "h"`, skillMatch("a b c d e f g h i j"), "at most eight words")
	for i := 0; i < 30; i++ {
		_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf(fmt.Sprintf("bulk-%d", i), "common bulk words", "b"), Digest: dg(400 + i), Kind: PublisherOperator})
		require.NoError(t, err)
	}
	hits, _ = ss.SearchSkills(ctx, "common", 100)
	assert.Len(t, hits, 20, "a result cap")
}

func TestTheSkillStoreHasACapAndALog(t *testing.T) {
	ctx, ss, db := skillStore(t)
	for i := 0; i < MaxSkills; i++ {
		_, err := db.ExecContext(ctx, `INSERT INTO skills (id, name, version, digest, status, publisher_kind, created_at) VALUES (?, ?, 1, ?, 'approved', 'operator', 'now')`, fmt.Sprintf("id%d", i), fmt.Sprintf("s%d", i), dg(5000+i))
		require.NoError(t, err)
	}
	_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("one-too-many", "d", "b"), Digest: dg(9999), Kind: PublisherOperator})
	assert.ErrorIs(t, err, ErrTooManySkills)
	require.NoError(t, ss.RemoveSkill(ctx, "id1"))
	row, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("fits-now", "d", "b"), Digest: dg(9998), Kind: PublisherOperator})
	require.NoError(t, err, "a removed skill's tombstone does not count")
	require.NoError(t, ss.RemoveSkill(ctx, row.ID))
	var events []string
	require.NoError(t, db.SelectContext(ctx, &events, `SELECT event FROM skills_log ORDER BY id`))
	assert.Equal(t, []string{"remove", "publish", "remove"}, events, "publish, approve, reject and remove are logged")
}

func TestBadSkillRecordsAreRefused(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	for name, in := range map[string]AddSkillInput{
		"no skill":      {Digest: dg(1), Kind: PublisherOperator},
		"bad digest":    {Skill: skillOf("a", "d", "b"), Digest: "xyz", Kind: PublisherOperator},
		"bad kind":      {Skill: skillOf("a", "d", "b"), Digest: dg(1), Kind: "someone"},
		"agent no name": {Skill: skillOf("a", "d", "b"), Digest: dg(1), Kind: PublisherAgent},
	} {
		_, _, err := addSkill(ctx, ss, in)
		assert.ErrorIs(t, err, ErrBadSkill, name)
	}
}

// #12020 (Security's SHOULD): the digest is bound to the parsed skill: a skill whose bytes are not the ones named is refused when it is added and when it is approved, so the text indexed is the text of the digest approved.
func TestTheSkillAndItsDigestMustBeTheSameBytes(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	other := skillOf("db-review", "Checks a SQL migration.", "Look for ALTER TABLE.")
	other.Digest = dg(900)
	_, _, err := ss.AddSkill(ctx, AddSkillInput{Skill: other, Digest: dg(901), Kind: PublisherOperator})
	assert.ErrorIs(t, err, ErrSkillDigest, "added: the skill was parsed from other bytes than the digest names")
	_, _, err = ss.AddSkill(ctx, AddSkillInput{Skill: skillOf("db-review", "d", "b"), Digest: dg(902), Kind: PublisherOperator}) // no digest on the skill at all
	assert.ErrorIs(t, err, ErrSkillDigest)

	sk := skillOf("db-review", "Checks a SQL migration.", "Look for ALTER TABLE.")
	row, _, err := addSkill(ctx, ss, AddSkillInput{Skill: sk, Digest: dg(903), Kind: PublisherAgent, Agent: "Dev"})
	require.NoError(t, err)
	stranger := skillOf("db-review", "Searchable stranger words.", "Another text.")
	stranger.Digest = dg(904)
	assert.ErrorIs(t, ss.ApproveSkill(ctx, row.ID, dg(903), false, stranger), ErrSkillDigest, "approve digest A with the text of zip B")
	hits, _ := ss.SearchSkills(ctx, "stranger", 10)
	assert.Empty(t, hits, "nothing of the other text was indexed")
	require.NoError(t, ss.ApproveSkill(ctx, row.ID, dg(903), false, sk))
}

// #12020 (Security's SHOULD): an agent's skill holds only documents and data.
func TestAnAgentsSkillHoldsOnlyDocumentsAndData(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	file := func(p string) skills.File {
		return skills.File{Path: p, Size: 3, Kind: skills.KindText, SHA256: strings.Repeat("d", 64)}
	}
	_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf("docs-only", "d", "b", file("references/a.md"), file("data/t.csv")), Digest: dg(910), Kind: PublisherAgent, Agent: "Dev"})
	require.NoError(t, err)
	for i, p := range []string{"tool", "helper.html", "x.py", "run"} {
		_, _, err := addSkill(ctx, ss, AddSkillInput{Skill: skillOf(fmt.Sprintf("other-%d", i), "d", "b", file(p)), Digest: dg(920 + i), Kind: PublisherAgent, Agent: "Dev"})
		assert.ErrorIs(t, err, ErrAgentScripts, p)
	}
	// the Operator's own is not held to it
	_, _, err = addSkill(ctx, ss, AddSkillInput{Skill: skillOf("operators", "d", "b", file("tool")), Digest: dg(930), Kind: PublisherOperator})
	assert.NoError(t, err)
}
