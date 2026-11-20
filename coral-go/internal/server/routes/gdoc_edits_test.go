package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gdocsync"
	"github.com/subgentic/coral/internal/store"
)

// Slice E (#20047): an edit made in the shared Doc comes back into Coral by itself, as a new version of the file's series, or kept beside a newer version made in Coral.

const gdocTeam = "alpha-team"

// writeTeamVersion is writeSeriesVersion for a file of a team, which is what a version needs to be joined by a new one.
func (g *gdocRig) writeTeamVersion(t *testing.T, sid, digest string, n int) {
	t.Helper()
	dir := uploadsDir(g.h.cfg.CoralDir(), "s1")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	rec := agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Digest: digest}, CreatedAt: "2026-11-20T00:00:00Z", SeriesID: sid, Version: n, Board: gdocTeam, Uploader: "Writer"}
	b, _ := json.Marshal(rec)
	require.NoError(t, os.WriteFile(filepath.Join(dir, digest+".json"), b, 0o600))
}

// editRig is a team file shared at version 1 (the first press), with the Doc as Coral left it.
func editRig(t *testing.T) *gdocRig {
	t.Helper()
	g := newGdocRig(t, true)
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Friday.\n\nShip the build.\n")
	g.writeTeamVersion(t, gdocSid, gdocV1, 1)
	status, _, raw := g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	return g
}

// editDoc is what Google then has: the Doc as someone edited it, at a new revision. The first line is the one Coral put at the top.
func (g *gdocRig) editDoc(md, rev string) {
	g.drive.mu.Lock()
	defer g.drive.mu.Unlock()
	g.drive.docs["doc1"] = gdocsync.ParseMarkdown("Written in Coral.\n\n" + md)
	if g.drive.revs == nil {
		g.drive.revs = map[string]string{}
	}
	g.drive.revs["doc1"] = rev
}

func (g *gdocRig) objectText(t *testing.T, digest string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(g.h.artifactDir(), digest))
	require.NoError(t, err)
	return string(b)
}

func sumOf(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestAnEditMadeInTheDocBecomesTheNextVersionAndIsNotSentBack(t *testing.T) {
	g := editRig(t)
	edited := "# Plan\n\nThe launch is on Sunday.\n\nShip the build.\n"
	g.editDoc(edited, "rev-google-2")
	batches, uploads := g.drive.batches, len(g.drive.uploads)
	g.pass(&gdocSyncState{})

	members := seriesMembers(g.h.cfg.CoralDir(), gdocSid)
	require.Len(t, members, 2, "the edit is version 2 of the same file")
	got := members[1]
	assert.Equal(t, sumOf(strings.TrimSpace(edited)+"\n"), got.Digest, "the Doc's text, without the line Coral put at the top")
	text := g.objectText(t, got.Digest)
	assert.Contains(t, text, "Sunday")
	assert.NotContains(t, text, "Written")
	assert.Equal(t, sourceGdocEdit, got.Source)
	assert.Equal(t, gdocEditUploader, got.Uploader, "no one is named as its writer: anyone with the Doc could have written it")
	assert.Equal(t, gdocTeam, got.Board)
	row := g.share1(t)
	assert.Equal(t, got.Digest, row.Digest, "the share remembers it as the version in the Doc")
	assert.Equal(t, "rev-google-2", row.DocRevision, "and the revision, so the push does not send it back")
	assert.Equal(t, batches, g.drive.batches, "nothing was written to the Doc")
	assert.Len(t, g.drive.uploads, uploads, "no new Doc")

	g.pass(&gdocSyncState{}) // again: the same revision is nothing new
	assert.Len(t, seriesMembers(g.h.cfg.CoralDir(), gdocSid), 2)
	assert.Equal(t, batches, g.drive.batches)
}

func TestAnEditThatOnlyChangesTheDocsSpacingMakesNoVersion(t *testing.T) {
	g := editRig(t)
	g.editDoc("# Plan\n\nThe launch is on Friday.\n\nShip the build.\n\n\n", "rev-google-2")
	g.pass(&gdocSyncState{})
	assert.Len(t, seriesMembers(g.h.cfg.CoralDir(), gdocSid), 1, "the same words are the same version")
	assert.Equal(t, "rev-google-2", g.share1(t).DocRevision, "the new revision is remembered all the same")
}

func TestAnEditInTheDocAndANewerVersionInCoralAreBothKept(t *testing.T) {
	g := editRig(t)
	g.artifact(t, gdocV2, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Monday.\n\nShip the build.\n")
	g.writeTeamVersion(t, gdocSid, gdocV2, 2)
	g.editDoc("# Plan\n\nThe launch is on Sunday.\n\nShip the build.\n", "rev-google-2")
	batches := g.drive.batches
	g.pass(&gdocSyncState{})

	members := seriesMembers(g.h.cfg.CoralDir(), gdocSid)
	require.Len(t, members, 2, "Coral's own newest version is still the newest: the edit did not take its place")
	assert.Equal(t, gdocV2, members[1].Digest)
	// the Google edit is a file of its own, beside it, in the same team
	sep := ""
	_ = filepath.Walk(uploadsDir(g.h.cfg.CoralDir(), "s1"), func(p string, fi os.FileInfo, err error) error {
		if err == nil && strings.HasSuffix(p, ".json") {
			b, _ := os.ReadFile(p)
			var rec agentUploadRecord
			if json.Unmarshal(b, &rec) == nil && strings.Contains(rec.Name, "(edited in Google)") {
				sep = strings.TrimSuffix(filepath.Base(p), ".json")
				assert.Equal(t, sourceGdocEdit, rec.Source)
				assert.Equal(t, gdocTeam, rec.Board)
				assert.Equal(t, "plan (edited in Google).md", rec.Name)
			}
		}
		return nil
	})
	require.NotEmpty(t, sep, "the edit is kept as its own file")
	assert.Contains(t, g.objectText(t, sep), "Sunday")
	// and the Doc was not written over: the loop's keep-both put Coral's version in a new Doc and kept the edited one
	assert.Equal(t, batches, g.drive.batches)
	require.Len(t, g.drive.uploads, 2)
	row := g.share1(t)
	assert.Equal(t, "doc2", row.DocID)
	assert.Equal(t, "doc1", row.ConflictDoc, "the Doc with the edit stays, and the owner is pointed at it")
	assert.Equal(t, gdocV2, row.Digest)

	g.pass(&gdocSyncState{}) // nothing more happens, and no second copy of the edit
	assert.Len(t, g.drive.uploads, 2)
}

func TestAPausedDocIsNotReadForEdits(t *testing.T) {
	g := editRig(t)
	g.editDoc("# Plan\n\nThe launch is on Sunday.\n", "rev-google-2")
	ok, err := g.ss.SetGdocShareState(context.Background(), gdocSid, store.GdocSharePaused)
	require.NoError(t, err)
	require.True(t, ok)
	calls := g.drive.calls
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls, "no Google call for a paused Doc")
	assert.Len(t, seriesMembers(g.h.cfg.CoralDir(), gdocSid), 1)
}

func TestAnEmptyOrTooLargeEditIsNotTaken(t *testing.T) {
	g := editRig(t)
	g.editDoc("", "rev-google-2")
	g.pass(&gdocSyncState{})
	assert.Len(t, seriesMembers(g.h.cfg.CoralDir(), gdocSid), 1, "an emptied Doc is not a new version")
	g.editDoc(strings.Repeat("word ", gdocMaxMarkdown/5+10), "rev-google-3")
	g.pass(&gdocSyncState{})
	assert.Len(t, seriesMembers(g.h.cfg.CoralDir(), gdocSid), 1, "a Doc over the size cap is not a new version")
	assert.Equal(t, "rev1", g.share1(t).DocRevision, "and nothing was recorded")
}

func TestAnEditIsReadAsPlainDataAndABadLinkNeverComesThrough(t *testing.T) {
	g := editRig(t)
	g.editDoc("# Plan\n\nSee [click](javascript:alert(1)) and [ok](https://example.com/a).\n", "rev-google-2")
	g.pass(&gdocSyncState{})
	members := seriesMembers(g.h.cfg.CoralDir(), gdocSid)
	require.Len(t, members, 2)
	text := g.objectText(t, members[1].Digest)
	assert.NotContains(t, text, "javascript:")
}

func TestADocThatCannotBeReadIsLeftAsItIs(t *testing.T) {
	g := editRig(t)
	g.editDoc("# Plan\n\nThe launch is on Sunday.\n", "rev-google-2")
	g.drive.fail, g.drive.failStatus = 20, 500 // every try fails
	g.pass(&gdocSyncState{})
	assert.Len(t, seriesMembers(g.h.cfg.CoralDir(), gdocSid), 1)
	assert.Equal(t, "rev1", g.share1(t).DocRevision)
	assert.Equal(t, 0, g.drive.batches, "and nothing was written over it")
}
