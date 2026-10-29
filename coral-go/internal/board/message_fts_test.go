package board

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9451: the message search index. It narrows a text search and never changes its answer: every case below is compared with the Go scan
// (queryBoth in message_query_sql_test.go forces the scan with an identity Shown), and the index's own counter says it did the work.

func ftsStoreWithMessages(t *testing.T, texts []string, n int) *Store {
	t.Helper()
	s := testStore(t)
	ctx := context.Background()
	_, err := sub(s, ctx, "proj", "dev", "Backend Dev")
	require.NoError(t, err)
	for i := 0; i < n; i++ {
		_, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s #%d", texts[i%len(texts)], i), nil)
		require.NoError(t, err)
	}
	return s
}

var ftsTexts = []string{"Progress report", "no match here", "PROGRESS again", "100% done_ok", "back\\slash 100%", "a_b", "axb", "Pro-gress", "progress",
	"ünï progress", "École normale ÉCOLE", `she said "hi" there`, `quote " alone`, "x", "ab", "Zürich zürich ZÜRICH", "tab\tsep and new\nline", "the quick brown fox"}

var ftsNeedles = []string{"progress", "PROGRESS", "Progress rep", "100%", "a_b", "\\", "%", "x", "ab", "#1", "no match", "zzz", "report", "école", "ÉCOLE", "zürich",
	`"hi"`, `"`, `said "hi" th`, "quick brown", "the", "own fox", "Pro-g", "_ok", "slash 1", "ünï", "ïn", "d_ok"}

func answered(s *Store) int64 { return s.msgIndexAnswers.Load() }

func isASCII(s string) bool {
	for _, r := range s {
		if r > 127 {
			return false
		}
	}
	return true
}

func TestMessageSearchIndexAnswersLikeTheScan(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 150)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	require.Equal(t, "ready", s.MessageSearchIndexState())
	via, short := 0, 0
	for _, needle := range ftsNeedles {
		for _, sort := range []string{"newest", "oldest"} {
			p := MessageQueryParams{Q: []string{needle}, Sort: []string{sort}, Limit: []string{"7"}}
			before := answered(s)
			a, b := queryBoth(t, s, p)
			require.Equal(t, b, a, "%q %s", needle, sort)
			if len([]rune(needle)) >= 3 && isASCII(needle) {
				require.Greater(t, answered(s), before, "the index answers %q", needle)
				via++
			} else { // under three characters there is no trigram; a non-ASCII needle was always the Go scan's
				require.Equal(t, before, answered(s), "%q is answered as before", needle)
				short++
			}
			for pages, cur := 0, a.NextCursor; cur != "" && pages < 30; pages++ { // every page of the walk, forward and back
				p.Cursor = []string{cur}
				a, b = queryBoth(t, s, p)
				require.Equal(t, b, a, "%q %s forward", needle, sort)
				cur = a.NextCursor
				if a.PrevCursor != "" {
					pp := p
					pp.Cursor = []string{a.PrevCursor}
					pa, pb := queryBoth(t, s, pp)
					require.Equal(t, pb, pa, "%q %s back", needle, sort)
				}
			}
		}
	}
	require.Greater(t, via, 20)
	require.Greater(t, short, 2)
}

func TestMessageSearchIndexLeavesCommonNeedlesToTheScan(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 120)
	require.NoError(t, s.BuildMessageSearchIndex(context.Background()))
	old := messageFTSMaxCandidates
	messageFTSMaxCandidates = 10
	defer func() { messageFTSMaxCandidates = old }()
	before := answered(s)
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"progress"}, Limit: []string{"50"}})
	require.Equal(t, b, a)
	require.Greater(t, a.Total, 10)
	require.Equal(t, before, answered(s), "a needle that most messages hold is answered without the index")
	a, b = queryBoth(t, s, MessageQueryParams{Q: []string{"quick brown"}})
	require.Equal(t, b, a)
	require.Greater(t, answered(s), before, "a selective one is not")
}

func TestMessageSearchIndexGuardsFallBackToTheScan(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 40)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	run := func(needle string) (hit bool) {
		before := answered(s)
		a, b := queryBoth(t, s, MessageQueryParams{Q: []string{needle}, Limit: []string{"50"}})
		require.Equal(t, b, a, needle)
		return answered(s) > before
	}
	require.True(t, run("progress"))
	res, err := s.db.ExecContext(ctx, `INSERT INTO board_messages(project, session_id, subscriber_id, content, created_at) VALUES ('proj', 'dev', 'dev', ?, '2026-10-27T00:00:00Z')`, "before\x00progress after") // LIKE stops at a NUL: the scan answers
	require.NoError(t, err)
	nulID, _ := res.LastInsertId()
	assert.False(t, run("progress"), "a message with a NUL byte: the scan answers")
	ok, err := s.DeleteMessage(ctx, "proj", nulID)
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, run("progress"), "the NUL message is gone: the index answers again")
	k, err := s.PostMessage(ctx, "proj", "dev", "İstanbul progress", nil) // U+0130: Go folds it to i, LIKE does not
	require.NoError(t, err)
	assert.False(t, run("istanbul"), "a needle with an i and a message with U+0130: the scan answers")
	assert.True(t, run("progress"), "a needle with no i or k is not affected by U+0130 ... ")
	_, err = s.DeleteMessage(ctx, "proj", k.ID)
	require.NoError(t, err)
	assert.True(t, run("istanbul"))
}

func TestMessageSearchIndexTriggersKeepItInStep(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 30)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	m, err := s.PostMessage(ctx, "proj", "dev", "a brand new marker-aardvark message", nil)
	require.NoError(t, err)
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"aardvark"}})
	require.Equal(t, b, a)
	require.Equal(t, 1, a.Total, "a message posted after the build is found")
	ok, err := s.DeleteMessage(ctx, "proj", m.ID)
	require.NoError(t, err)
	require.True(t, ok)
	a, b = queryBoth(t, s, MessageQueryParams{Q: []string{"aardvark"}})
	require.Equal(t, b, a)
	require.Equal(t, 0, a.Total, "a deleted message is gone from the answer")
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'edited zebra text' WHERE id = (SELECT MIN(id) FROM board_messages)`)
	require.NoError(t, err)
	a, b = queryBoth(t, s, MessageQueryParams{Q: []string{"zebra"}})
	require.Equal(t, b, a)
	require.Equal(t, 1, a.Total, "an edited message is found by its new text")
	a, b = queryBoth(t, s, MessageQueryParams{Q: []string{"Progress report #0"}})
	require.Equal(t, b, a)
	require.Equal(t, 0, a.Total, "and not by the old")
	require.NoError(t, s.DeleteProject(ctx, "proj"))
	var rows int
	require.NoError(t, s.db.GetContext(ctx, &rows, `SELECT COUNT(*) FROM `+messageFTSTable+` WHERE `+messageFTSTable+` MATCH '"pro"'`))
	require.Zero(t, rows, "a deleted project leaves nothing in the index")
	_, err = s.db.ExecContext(ctx, `INSERT INTO `+messageFTSTable+`(`+messageFTSTable+`, rank) VALUES ('integrity-check', 1)`)
	require.NoError(t, err, "the index equals its content table")
}

func TestMessageSearchIndexBuildsWhileMessagesArePosted(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 400)
	ctx := context.Background()
	old := messageFTSChunkForTest(50) // many chunks, so the posts land between them
	defer old()
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			_, _ = s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("late arrival number %d progress", i), nil)
			time.Sleep(time.Millisecond)
		}
	}()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	close(stop)
	wg.Wait()
	_, err := s.db.ExecContext(ctx, `INSERT INTO `+messageFTSTable+`(`+messageFTSTable+`, rank) VALUES ('integrity-check', 1)`)
	require.NoError(t, err, "every message, the ones posted during the build too, is indexed once")
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"late arrival"}, Limit: []string{"200"}})
	require.Equal(t, b, a)
	require.Greater(t, a.Total, 0)
	var nul, ik int64
	require.NoError(t, s.db.QueryRowxContext(ctx, `SELECT nul, ik FROM `+messageFTSMeta).Scan(&nul, &ik))
	require.Zero(t, nul+ik)
}

func TestMessageSearchIndexDisableDropsIt(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 300)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	freed, err := s.DisableMessageSearchIndex(ctx, false)
	require.NoError(t, err)
	require.Greater(t, freed, int64(0), "the index's pages are free")
	require.Equal(t, "off", s.MessageSearchIndexState())
	require.False(t, s.messageIndexExists(ctx))
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'board_messages_fts_%'`))
	require.Zero(t, n, "its triggers are gone: a post does not touch a missing table")
	_, err = s.PostMessage(ctx, "proj", "dev", "posted after the drop", nil)
	require.NoError(t, err)
	before := answered(s)
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"after the drop"}})
	require.Equal(t, b, a)
	require.Equal(t, 1, a.Total)
	require.Equal(t, before, answered(s))
	_, err = s.DisableMessageSearchIndex(ctx, true) // again, with a vacuum: nothing to drop, no error
	require.NoError(t, err)
}

func TestMessageSearchIndexSettingAtOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	open := func() *Store {
		s, err := NewStoreWithKey(path, "")
		require.NoError(t, err)
		t.Cleanup(func() { s.Close() })
		return s
	}
	wait := func(s *Store, want string) {
		require.Eventually(t, func() bool { return s.MessageSearchIndexState() == want }, 10*time.Second, 5*time.Millisecond, "state %s", want)
	}
	s := open()
	require.Equal(t, "off", s.MessageSearchIndexState(), "off while the setting is off (the test binary sets it)")
	ctx := context.Background()
	_, err := sub(s, ctx, "proj", "dev", "Dev")
	require.NoError(t, err)
	for i := 0; i < 40; i++ {
		_, err = s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s %d", ftsTexts[i%len(ftsTexts)], i), nil)
		require.NoError(t, err)
	}
	require.NoError(t, s.Close())
	t.Setenv(messageSearchIndexEnv, "on")
	s = open()
	wait(s, "ready") // built in the background at open
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"progress"}})
	require.Equal(t, b, a)
	require.NoError(t, s.Close())
	s = open()
	require.Equal(t, "ready", s.MessageSearchIndexState(), "a complete index is found at the next open, not built again")
	require.NoError(t, s.Close())
	t.Setenv(messageSearchIndexEnv, "off")
	s = open()
	require.Eventually(t, func() bool { return !s.messageIndexExists(ctx) }, 10*time.Second, 5*time.Millisecond, "the setting off drops it")
	require.Equal(t, "off", s.MessageSearchIndexState())
}

// BenchmarkMessageSearchIndex prints what the index costs and saves on a board of -benchtime-independent size (messageFTSBenchRows messages):
// go test ./internal/board -run xxx -bench MessageSearchIndex -benchtime 3x
func BenchmarkMessageSearchIndex(b *testing.B) {
	rows := 30000
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench.db"), "")
	require.NoError(b, err)
	b.Cleanup(func() { s.Close() })
	ctx := context.Background()
	words := strings.Fields("progress review task commit branch landing agent team message board goal release notes tests golden census batch frontend backend security hub tunnel")
	tx, err := s.db.BeginTxx(ctx, nil)
	require.NoError(b, err)
	textBytes := 0
	for i := 0; i < rows; i++ {
		var sb strings.Builder
		for j := 0; j < 30+i%50; j++ {
			sb.WriteString(words[(i*7+j*13)%len(words)])
			sb.WriteByte(' ')
		}
		if i%500 == 7 {
			sb.WriteString("zuerichunique")
		}
		textBytes += sb.Len()
		_, err := tx.ExecContext(ctx, `INSERT INTO board_messages(project, session_id, subscriber_id, content, created_at) VALUES ('proj','dev','dev',?,?)`, sb.String(), "2026-10-27T00:00:00Z")
		require.NoError(b, err)
	}
	require.NoError(b, tx.Commit())
	query := func(needle string) *MessageQuery {
		q, err := ParseMessageQuery(MessageQueryParams{Q: []string{needle}})
		require.NoError(b, err)
		q.Project = "proj"
		return q
	}
	for _, needle := range []string{"zuerichunique", "tests golden census", "progress"} {
		b.Run("without/"+needle, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := s.QueryMessages(ctx, query(needle))
				require.NoError(b, err)
			}
		})
	}
	t0 := time.Now()
	require.NoError(b, s.BuildMessageSearchIndex(ctx))
	var pages int64
	require.NoError(b, s.db.GetContext(ctx, &pages, `SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name LIKE 'board_messages_fts%'`))
	b.Logf("%d messages, %.1f MB of text: build %v, index %.1f MB (%.2f x the text)", rows, float64(textBytes)/1e6, time.Since(t0).Round(time.Millisecond), float64(pages)/1e6, float64(pages)/float64(textBytes))
	for _, needle := range []string{"zuerichunique", "tests golden census", "progress"} {
		b.Run("with/"+needle, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := s.QueryMessages(ctx, query(needle))
				require.NoError(b, err)
			}
		})
	}
}

func messageFTSChunkForTest(n int) func() {
	old := messageFTSChunk
	messageFTSChunk = n
	return func() { messageFTSChunk = old }
}

// A message deleted while the index is still being built (its chunk already indexed, the triggers not yet made) must not leave its words
// in the index: the integrity check finds them without a row to match (#10831: "fts5: corruption found reading blob" on a CI machine
// that deleted messages as the build ran).
func TestMessageSearchIndexBuildsWhileMessagesAreDeleted(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 600)
	ctx := context.Background()
	defer messageFTSChunkForTest(25)() // many chunks, so the deletes land between them
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for id := int64(1); id <= 600; id += 3 {
			select {
			case <-stop:
				return
			default:
			}
			_, _ = s.DeleteMessage(ctx, "proj", id)
			// an edit of another message, the same way: its old words must leave the index and its new words enter it
			_, _ = s.db.ExecContext(ctx, `UPDATE board_messages SET content = ? WHERE id = ?`, fmt.Sprintf("edited during the build %d", id), id+1)
			time.Sleep(200 * time.Microsecond)
		}
	}()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	close(stop)
	wg.Wait()
	_, err := s.db.ExecContext(ctx, `INSERT INTO `+messageFTSTable+`(`+messageFTSTable+`, rank) VALUES ('integrity-check', 1)`)
	require.NoError(t, err, "a message deleted during the build is not left in the index")
}

// An index built before the watermark existed (a meta table without upto, the three triggers) is complete as it was: opening it must not
// rebuild it.
func TestMessageIndexBuiltBeforeTheWatermarkIsComplete(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 20)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	require.True(t, s.messageIndexComplete(ctx))
	// what an older build left: the triggers without a guard (stood in for here by do-nothing ones with the same names) and a meta table without upto
	for _, q := range []string{
		`DROP TRIGGER board_messages_fts_ai`, `DROP TRIGGER board_messages_fts_ad`, `DROP TRIGGER board_messages_fts_au`,
		`ALTER TABLE ` + messageFTSMeta + ` DROP COLUMN upto`,
		`CREATE TRIGGER board_messages_fts_ai AFTER INSERT ON board_messages BEGIN SELECT 1; END`,
		`CREATE TRIGGER board_messages_fts_ad AFTER DELETE ON board_messages BEGIN SELECT 1; END`,
		`CREATE TRIGGER board_messages_fts_au AFTER UPDATE OF content ON board_messages BEGIN SELECT 1; END`,
	} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err, q)
	}
	require.True(t, s.messageIndexComplete(ctx), "no watermark column: the triggers alone say it is complete")
	_, err := s.db.ExecContext(ctx, `ALTER TABLE `+messageFTSMeta+` ADD COLUMN upto INTEGER NOT NULL DEFAULT 0`)
	require.NoError(t, err)
	require.False(t, s.messageIndexComplete(ctx), "a watermark that has not reached the end: a build that was interrupted")
}

// #10905: an index the old build race left stale (a message edited after its chunk was indexed, no trigger to say so) answers a search
// and misses the edited words; the check after open finds it and builds it again, and the words are found.
func TestMessageSearchIndexIsRepairedWhenItDoesNotMatchTheMessages(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 60)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	t.Setenv(messageSearchIndexEnv, "on") // the repair looks at the setting just before it rebuilds
	healthy, err := s.CheckMessageSearchIndex(ctx)
	require.NoError(t, err)
	require.False(t, healthy, "a healthy index is left as it is")

	// the old race's damage: the content changes with no trigger to tell the index
	_, err = s.db.ExecContext(ctx, `DROP TRIGGER board_messages_fts_au`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'rewritten after it was indexed: flamingo' WHERE id = 7`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, messageFTSTriggers[2])
	require.NoError(t, err)
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"flamingo"}, Limit: []string{"50"}})
	require.Equal(t, 1, b.Total, "the scan finds the edited message")
	require.NotEqual(t, b.Total, a.Total, "the stale index silently misses it: this is the damage")

	repaired, err := s.CheckMessageSearchIndex(ctx)
	require.NoError(t, err)
	require.True(t, repaired, "the check finds the mismatch and builds the index again")
	require.Equal(t, "ready", s.MessageSearchIndexState())
	before := answered(s)
	a, b = queryBoth(t, s, MessageQueryParams{Q: []string{"flamingo"}, Limit: []string{"50"}})
	require.Equal(t, b, a, "the rebuilt index finds what the scan finds")
	require.Equal(t, 1, a.Total)
	require.Greater(t, answered(s), before, "and the index is the one that answered")
}

// The check is bounded: a board over the limit is not read at all, whatever state its index is in.
func TestMessageSearchIndexCheckLeavesABigBoardAlone(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsTexts, 30)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	t.Setenv(messageSearchIndexEnv, "on") // the repair looks at the setting just before it rebuilds
	old := messageIndexCheckMaxMessages
	messageIndexCheckMaxMessages = 10
	defer func() { messageIndexCheckMaxMessages = old }()
	_, err := s.db.ExecContext(ctx, `DROP TRIGGER board_messages_fts_au`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'changed quietly: pelican' WHERE id = 3`)
	require.NoError(t, err)
	repaired, err := s.CheckMessageSearchIndex(ctx)
	require.NoError(t, err)
	require.False(t, repaired, "over the limit: not checked, so not repaired")
}

// On open, a complete index is checked after messageIndexCheckDelay without anyone asking: a store opened on a stale index finds the
// edited words a moment later.
func TestMessageSearchIndexIsCheckedAfterOpen(t *testing.T) {
	t.Setenv(messageSearchIndexEnv, "on") // a store builds or finds its index at open only when the setting is on
	path := filepath.Join(t.TempDir(), "board_check.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	ctx := context.Background()
	_, err = sub(s, ctx, "proj", "dev", "Backend Dev")
	require.NoError(t, err)
	for i := 0; i < 40; i++ {
		_, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s #%d", ftsTexts[i%len(ftsTexts)], i), nil)
		require.NoError(t, err)
	}
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	for _, q := range []string{`DROP TRIGGER board_messages_fts_au`, `UPDATE board_messages SET content = 'edited later: heron' WHERE id = 5`, messageFTSTriggers[2]} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err)
	}
	require.NoError(t, s.Close())

	defer func(d time.Duration) { messageIndexCheckDelay = d }(messageIndexCheckDelay)
	messageIndexCheckDelay = 400 * time.Millisecond
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer s.Close()
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"heron"}, Limit: []string{"50"}})
	require.NotEqual(t, b.Total, a.Total, "just after open the stale index still misses the edited word (the check has not run yet)")
	require.Eventually(t, func() bool {
		a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"heron"}, Limit: []string{"50"}})
		return b.Total == 1 && a.Total == 1
	}, 10*time.Second, 50*time.Millisecond, "the check after open rebuilt the index: the edited word is found through it")
}

// #10913: the repair looks at the disk first, as every build does. Without the room for a new index the stale one stays (a search answers
// as it did) and nothing is dropped.
func TestMessageSearchIndexRepairNeedsRoomOnTheDisk(t *testing.T) {
	t.Setenv(messageSearchIndexEnv, "on")
	path := filepath.Join(t.TempDir(), "board_room.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	_, err = sub(s, ctx, "proj", "dev", "Backend Dev")
	require.NoError(t, err)
	for i := 0; i < 40; i++ {
		_, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s #%d", ftsTexts[i%len(ftsTexts)], i), nil)
		require.NoError(t, err)
	}
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	for _, q := range []string{`DROP TRIGGER board_messages_fts_au`, `UPDATE board_messages SET content = 'edited later: ibis' WHERE id = 5`, messageFTSTriggers[2]} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err)
	}
	old := messageIndexFreeSpace
	messageIndexFreeSpace = func(string) (uint64, error) { return 1 << 10, nil } // 1 KiB free
	defer func() { messageIndexFreeSpace = old }()
	repaired, err := s.CheckMessageSearchIndex(ctx)
	require.NoError(t, err)
	require.False(t, repaired, "no room: not rebuilt")
	require.Equal(t, "ready", s.MessageSearchIndexState(), "the old index stays in place")
	require.True(t, s.messageIndexComplete(ctx), "and is not dropped")
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"ibis"}, Limit: []string{"50"}})
	require.NotEqual(t, b.Total, a.Total, "still the stale one: it keeps answering as it did")

	messageIndexFreeSpace = old
	repaired, err = s.CheckMessageSearchIndex(ctx)
	require.NoError(t, err)
	require.True(t, repaired, "with room, the next check rebuilds it")
}

// #10913: an Operator who turns the index off while the check is running does not see it come back.
func TestMessageSearchIndexTurnedOffDuringTheCheckStaysOff(t *testing.T) {
	t.Setenv(messageSearchIndexEnv, "on")
	s := ftsStoreWithMessages(t, ftsTexts, 40)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	for _, q := range []string{`DROP TRIGGER board_messages_fts_au`, `UPDATE board_messages SET content = 'edited later: kiwi' WHERE id = 5`, messageFTSTriggers[2]} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err)
	}
	messageIndexBeforeRepair = func() { // the Operator turns the index off now: the setting and the store's state, as Settings does
		t.Setenv(messageSearchIndexEnv, "off")
		_, _ = s.DisableMessageSearchIndex(ctx, false)
	}
	defer func() { messageIndexBeforeRepair = nil }()
	repaired, err := s.CheckMessageSearchIndex(ctx)
	require.NoError(t, err)
	require.False(t, repaired, "turned off: not rebuilt")
	require.Equal(t, "off", s.MessageSearchIndexState())
	require.False(t, s.messageIndexExists(ctx), "and no index table came back")
}
