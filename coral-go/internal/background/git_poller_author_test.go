package background

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8996: a snapshot records who made the tip commit and the identity configured in the checkout, each as a name and a hash of the email: never the email.
func TestGitPollerRecordsTheAuthorAndTheCheckoutsIdentityAsHashes(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	runGit(t, repo, "config", "user.name", "Operator")
	runGit(t, repo, "config", "user.email", "operator@example.invalid")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("one\n"), 0o600))
	runGit(t, repo, "add", ".")
	cmd := exec.Command("git", "-C", repo, "commit", "-q", "-m", "Pipe | in the subject", "--author=Backend Dev <backend-dev@example.invalid>")
	cmd.Env = append(os.Environ(), "GIT_COMMITTER_NAME=Backend Dev", "GIT_COMMITTER_EMAIL=backend-dev@example.invalid")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))

	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	gs := store.NewGitStore(db)
	p := NewGitPoller(gs, nil, time.Minute)
	hasher := store.NewIdentityHasher(store.NewRemoteServerStore(db, t.TempDir()))
	p.SetIdentityHasher(hasher)
	p.discoverFn = func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentName: "Backend Dev", AgentType: "claude", SessionID: "s-1", WorkingDirectory: repo}}, nil
	}
	require.NoError(t, p.PollOnce(context.Background()))

	var row struct {
		Subject string `db:"commit_subject"`
		Author  string `db:"author_name"`
		AuthorH string `db:"author_hash"`
		Ident   string `db:"ident_name"`
		IdentH  string `db:"ident_hash"`
	}
	require.NoError(t, db.Get(&row, `SELECT commit_subject, author_name, author_hash, ident_name, ident_hash FROM git_snapshots WHERE session_id = 's-1'`))
	assert.Equal(t, "Pipe | in the subject", row.Subject, "a separator in the subject does not shift the fields")
	assert.Equal(t, "Backend Dev", row.Author)
	assert.Equal(t, hasher("backend-dev@example.invalid"), row.AuthorH)
	assert.Equal(t, "Operator", row.Ident)
	assert.Equal(t, hasher("operator@example.invalid"), row.IdentH)
	assert.NotEqual(t, row.AuthorH, row.IdentH)
	var leaked int
	require.NoError(t, db.Get(&leaked, `SELECT COUNT(*) FROM git_snapshots WHERE author_hash LIKE '%@%' OR ident_hash LIKE '%@%' OR author_name LIKE '%@%' OR ident_name LIKE '%@%'`))
	assert.Equal(t, 0, leaked, "no email address is stored")
}

// #9046: a subject that holds the field separator cannot fill the author fields: the subject is the last field, and the split takes at most five.
func TestAGitSubjectWithTheFieldSeparatorCannotFillTheAuthorFields(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("one\n"), 0o600))
	runGit(t, repo, "add", ".")
	cmd := exec.Command("git", "-C", repo, "commit", "-q", "-m", "x\x1fForged Author\x1fforged@example.invalid\x1fmore", "--author=Backend Dev <backend-dev@example.invalid>")
	cmd.Env = append(os.Environ(), "GIT_COMMITTER_NAME=Backend Dev", "GIT_COMMITTER_EMAIL=backend-dev@example.invalid")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	info, err := queryGit(context.Background(), repo)
	require.NoError(t, err)
	assert.Equal(t, "Backend Dev", info.AuthorName)
	assert.Equal(t, "backend-dev@example.invalid", info.authorEmail)
	assert.Contains(t, info.CommitSubject, "Forged Author", "the whole subject, separators and all, stays the subject")
	assert.Len(t, info.CommitHash, 40)
}

// Without a hasher no pseudonym is stored (the names still match commits to sessions).
func TestGitPollerWithoutAHasherStoresNoEmailPseudonym(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	runGit(t, repo, "config", "user.email", "operator@example.invalid")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("one\n"), 0o600))
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-q", "-m", "base")
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	p := NewGitPoller(store.NewGitStore(db), nil, time.Minute)
	p.discoverFn = func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentName: "A", AgentType: "claude", SessionID: "s-2", WorkingDirectory: repo}}, nil
	}
	require.NoError(t, p.PollOnce(context.Background()))
	var n int
	require.NoError(t, db.Get(&n, `SELECT COUNT(*) FROM git_snapshots WHERE session_id = 's-2' AND author_hash = '' AND ident_hash = '' AND author_name != ''`))
	assert.Equal(t, 1, n)
}
