package background

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9046: the poller read `git log` with 0x1f between the fields, so an author name or a subject that held a 0x1f shifted every field after it
// (the author's name became the e-mail). The fields are NUL separated now, and a NUL cannot be in either.
func TestQueryGitFieldsSurviveAUnitSeparatorInANameAndASubject(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	runGit(t, repo, "-c", "user.name=Ann\x1fBot", "-c", "user.email=ann@example.test", "commit", "-q", "--allow-empty", "-m", "fix\x1fthe poller\x1f")
	info, err := queryGit(context.Background(), repo)
	require.NoError(t, err)
	assert.Equal(t, "Ann\x1fBot", info.AuthorName, "the whole name, not the part before the 0x1f")
	assert.Equal(t, "fix\x1fthe poller\x1f", info.CommitSubject, "the whole subject, both separators kept")
	assert.NotEmpty(t, info.CommitTimestamp)
	assert.Regexp(t, `^[0-9a-f]{40}$`, info.CommitHash)
	assert.Regexp(t, `^\d{4}-\d\d-\d\dT`, info.CommitTimestamp, "the date is the date, not a name")
	assert.Equal(t, "ann@example.test", info.authorEmail, "the e-mail is the e-mail (the poller hashes it later)")
}

// A commit with an empty message: -z ends the record with one NUL after the empty subject, and only that one is trimmed, so the five fields are still five.
func TestQueryGitAnEmptySubjectIsAnEmptySubject(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	runGit(t, repo, "-c", "user.name=Ann", "-c", "user.email=ann@example.test", "commit", "-q", "--allow-empty", "--allow-empty-message", "-m", "")
	info, err := queryGit(context.Background(), repo)
	require.NoError(t, err)
	assert.Equal(t, "", info.CommitSubject)
	assert.Equal(t, "Ann", info.AuthorName)
	assert.Equal(t, "ann@example.test", info.authorEmail)
	assert.Regexp(t, `^[0-9a-f]{40}$`, info.CommitHash)
}
