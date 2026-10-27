package board

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/subgentic/coral/internal/safego"
)

// The message search index (#9451): an FTS5 trigram index over board_messages.content that narrows a text search to the messages that
// can match, so a search no longer reads every message. It is ON unless CORAL_BOARD_SEARCH_INDEX is off (the Operator's decision, #9685),
// because it costs disk (detail=none: about 0.6 times the text of the messages, measured in message_fts_test.go's benchmark) and building it
// takes seconds on a big board; Settings shows its state and size. The setting on builds it in the background at the first open (the search
// keeps answering as before until it is ready); off drops it. A build of SQLite without FTS5 (the Windows build) cannot have it: it stays off.
//
// The index only narrows: the query still asks LIKE of every candidate, so the answer is the one the scan gives while every message that
// LIKE matches is a candidate (a trigram index folds at least the case LIKE folds). Two things LIKE and Go's match disagree on, a NUL
// byte in a message and U+0130 or U+212A for a needle with an i or k, are counted by triggers in board_message_fts_meta, so the
// guards that scanned every message once per search are one row read. A needle under three characters has no trigram, the index is not
// ready, or a guard count is not zero: the search is answered as it was without the index (LIKE over the board, then the Go scan).
// Unlike that scan, the indexed search is not cut off by messageScanRows and messageScanBytes: its work is the candidates.

const (
	messageSearchIndexEnv = "CORAL_BOARD_SEARCH_INDEX"
	messageFTSTable       = "board_messages_fts"
	messageFTSMeta        = "board_message_fts_meta"
	messageFTSMaxTerms    = 32 // trigrams of a needle ANDed in the index query
)

// messageFTSChunk is the messages indexed per statement while building: the writer is free between them. A variable so a test can lower it.
var messageFTSChunk = 5000

// messageFTSMaxCandidates: a needle the index offers this many messages for matches most of the board, and the index is slower than the
// LIKE scan there (a trigram lookup of a common word, measured in the benchmark): the search is answered without it. A variable for a test.
var messageFTSMaxCandidates = 2000

// The index's state: what the search may use.
const (
	messageIndexOff int32 = iota
	messageIndexBuilding
	messageIndexReady
)

// messageSearchIndexWanted reports the setting: on unless the variable says off (0, false, off or no, in any case).
func messageSearchIndexWanted() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(messageSearchIndexEnv))) {
	case "0", "false", "off", "no":
		return false
	}
	return true
}

// messageSearchIndexAvailable is true when this SQLite has FTS5.
func (s *Store) messageSearchIndexAvailable(ctx context.Context) bool {
	var n int
	return s.db.GetContext(ctx, &n, `SELECT sqlite_compileoption_used('ENABLE_FTS5')`) == nil && n == 1
}

// MessageSearchIndexStatus is what Settings shows: the setting, whether this build can have the index, its state and the disk it takes.
type MessageSearchIndexStatus struct {
	Setting   string `json:"setting"`    // "on" or "off": CORAL_BOARD_SEARCH_INDEX
	Available bool   `json:"available"`  // false: this build of SQLite has no FTS5
	State     string `json:"state"`      // "off", "building" or "ready"
	SizeBytes int64  `json:"size_bytes"` // the index's tables and their indexes, 0 when there is none
}

// MessageSearchIndexStatus reports the index's setting, state and size.
func (s *Store) MessageSearchIndexStatus(ctx context.Context) MessageSearchIndexStatus {
	st := MessageSearchIndexStatus{Setting: "off", Available: s.messageSearchIndexAvailable(ctx), State: s.MessageSearchIndexState()}
	if messageSearchIndexWanted() {
		st.Setting = "on"
	}
	if s.messageIndexExists(ctx) {
		_ = s.db.GetContext(ctx, &st.SizeBytes, `SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name LIKE 'board_messages_fts%' OR name LIKE 'board_message_fts_meta%'`)
	}
	return st
}

// MessageSearchIndexState is "off", "building" or "ready".
func (s *Store) MessageSearchIndexState() string {
	switch s.msgIndex.Load() {
	case messageIndexReady:
		return "ready"
	case messageIndexBuilding:
		return "building"
	}
	return "off"
}

// applyMessageSearchIndexSetting is the store's step at open: the setting on builds the index (or finds it complete), off drops one a
// previous run left.
func (s *Store) applyMessageSearchIndexSetting() {
	ctx := context.Background()
	if messageSearchIndexWanted() {
		if !s.messageSearchIndexAvailable(ctx) {
			return // no FTS5 in this build: the search is answered without an index, quietly
		}
		if s.messageIndexComplete(ctx) {
			s.msgIndex.Store(messageIndexReady)
			return
		}
		s.startMessageSearchIndexBuild()
		return
	}
	if s.messageIndexExists(ctx) {
		go func() {
			defer safego.Recover("board/message_fts:drop")
			if _, err := s.DisableMessageSearchIndex(context.Background(), false); err != nil {
				log.Printf("board: dropping the message search index: %v", err)
			}
		}()
	}
}

func (s *Store) messageIndexExists(ctx context.Context) bool {
	var n int
	_ = s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM sqlite_master WHERE name IN (?, ?)`, messageFTSTable, messageFTSMeta)
	return n > 0
}

// messageIndexComplete: the triggers are the last thing a build creates, so their presence says the index holds every message.
func (s *Store) messageIndexComplete(ctx context.Context) bool {
	var n int
	_ = s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('board_messages_fts_ai', 'board_messages_fts_ad', 'board_messages_fts_au')`)
	return n == 3
}

// startMessageSearchIndexBuild builds the index in the background; the store's Close stops it.
func (s *Store) startMessageSearchIndexBuild() {
	if !s.msgIndex.CompareAndSwap(messageIndexOff, messageIndexBuilding) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.msgIndexStop.Store(&cancel)
	go func() {
		defer safego.Recover("board/message_fts:build")
		if err := s.buildMessageSearchIndex(ctx); err != nil {
			s.msgIndex.Store(messageIndexOff)
			if ctx.Err() == nil {
				log.Printf("board: building the message search index: %v", err)
			}
		}
	}()
}

// EnableMessageSearchIndex builds the index in the background when it is not built, and returns at once: the state says how far it is.
func (s *Store) EnableMessageSearchIndex(ctx context.Context) {
	if s.messageIndexComplete(ctx) {
		s.msgIndex.Store(messageIndexReady)
		return
	}
	s.startMessageSearchIndexBuild()
}

// BuildMessageSearchIndex builds the index now and returns when it is ready: the background build's work, for tests and for a caller that
// wants to wait. The writer is free between chunks, so a build does not hold up a post.
func (s *Store) BuildMessageSearchIndex(ctx context.Context) error {
	s.msgIndex.CompareAndSwap(messageIndexOff, messageIndexBuilding)
	err := s.buildMessageSearchIndex(ctx)
	if err != nil {
		s.msgIndex.Store(messageIndexOff)
	}
	return err
}

func (s *Store) buildMessageSearchIndex(ctx context.Context) error {
	if s.messageIndexComplete(ctx) {
		s.msgIndex.Store(messageIndexReady)
		return nil
	}
	// A partial index from an interrupted build is dropped and begun again: its triggers do not exist, so nothing depends on it.
	for _, q := range []string{
		`DROP TABLE IF EXISTS ` + messageFTSTable,
		`DROP TABLE IF EXISTS ` + messageFTSMeta,
		`CREATE VIRTUAL TABLE ` + messageFTSTable + ` USING fts5(content, content='board_messages', content_rowid='id', tokenize='trigram', detail=none)`,
		`CREATE TABLE ` + messageFTSMeta + ` (id INTEGER PRIMARY KEY CHECK (id = 1), nul INTEGER NOT NULL, ik INTEGER NOT NULL)`,
		`INSERT INTO ` + messageFTSMeta + ` (id, nul, ik) VALUES (1, 0, 0)`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("%s: %w", firstWords(q), err)
		}
	}
	var last int64
	for {
		var hi int64
		err := s.db.GetContext(ctx, &hi, `SELECT COALESCE(MAX(id), 0) FROM (SELECT id FROM board_messages WHERE id > ? ORDER BY id LIMIT ?)`, last, messageFTSChunk)
		if err != nil {
			return err
		}
		if hi == 0 {
			break
		}
		if err := s.indexMessageRange(ctx, last, hi); err != nil {
			return err
		}
		last = hi
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Millisecond): // the writer is free for a post between chunks
		}
	}
	// The last step is one short transaction: the messages posted while the chunks ran are indexed, and the triggers that keep the index in
	// step are created, with no message able to arrive in between (the writer is one connection).
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := indexRangeTx(ctx, tx, last, 1<<62); err != nil {
		return err
	}
	for _, q := range messageFTSTriggers {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("%s: %w", firstWords(q), err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.msgIndex.Store(messageIndexReady)
	return nil
}

func firstWords(q string) string {
	if f := strings.Fields(q); len(f) > 4 {
		return strings.Join(f[:4], " ")
	}
	return q
}

func (s *Store) indexMessageRange(ctx context.Context, after, upTo int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := indexRangeTx(ctx, tx, after, upTo); err != nil {
		return err
	}
	return tx.Commit()
}

// messageOddSQL are the two counts the triggers keep: messages with a NUL byte (LIKE stops reading a text at it) and messages with U+0130
// or U+212A (Go folds them to i and k, LIKE does not). Each is 1 or 0 for one message's text.
const (
	messageNulSQL = `(instr(CAST(%[1]s AS BLOB), CAST(char(0) AS BLOB)) > 0)`
	messageIkSQL  = `(instr(%[1]s, char(304)) > 0 OR instr(%[1]s, char(8490)) > 0)`
)

func indexRangeTx(ctx context.Context, tx *sqlx.Tx, after, upTo int64) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO `+messageFTSTable+`(rowid, content) SELECT id, content FROM board_messages WHERE id > ? AND id <= ?`, after, upTo); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE `+messageFTSMeta+` SET nul = nul + (SELECT COUNT(*) FROM board_messages WHERE id > ? AND id <= ? AND `+fmt.Sprintf(messageNulSQL, "content")+`),
		ik = ik + (SELECT COUNT(*) FROM board_messages WHERE id > ? AND id <= ? AND `+fmt.Sprintf(messageIkSQL, "content")+`)`, after, upTo, after, upTo)
	return err
}

var messageFTSTriggers = []string{
	`CREATE TRIGGER board_messages_fts_ai AFTER INSERT ON board_messages BEGIN
		INSERT INTO ` + messageFTSTable + `(rowid, content) VALUES (new.id, new.content);
		UPDATE ` + messageFTSMeta + ` SET nul = nul + ` + fmt.Sprintf(messageNulSQL, "new.content") + `, ik = ik + ` + fmt.Sprintf(messageIkSQL, "new.content") + `;
	END`,
	`CREATE TRIGGER board_messages_fts_ad AFTER DELETE ON board_messages BEGIN
		INSERT INTO ` + messageFTSTable + `(` + messageFTSTable + `, rowid, content) VALUES ('delete', old.id, old.content);
		UPDATE ` + messageFTSMeta + ` SET nul = nul - ` + fmt.Sprintf(messageNulSQL, "old.content") + `, ik = ik - ` + fmt.Sprintf(messageIkSQL, "old.content") + `;
	END`,
	`CREATE TRIGGER board_messages_fts_au AFTER UPDATE OF content ON board_messages BEGIN
		INSERT INTO ` + messageFTSTable + `(` + messageFTSTable + `, rowid, content) VALUES ('delete', old.id, old.content);
		INSERT INTO ` + messageFTSTable + `(rowid, content) VALUES (new.id, new.content);
		UPDATE ` + messageFTSMeta + ` SET nul = nul - ` + fmt.Sprintf(messageNulSQL, "old.content") + ` + ` + fmt.Sprintf(messageNulSQL, "new.content") + `, ik = ik - ` + fmt.Sprintf(messageIkSQL, "old.content") + ` + ` + fmt.Sprintf(messageIkSQL, "new.content") + `;
	END`,
}

// DisableMessageSearchIndex drops the index and its triggers: the search is answered without it from here on. It reports the pages the
// drop freed. SQLite keeps them in the file for the next rows; vacuum true also gives them back to the disk with a VACUUM, which
// rewrites the file and needs free space about its size, so it is a choice and not the default.
func (s *Store) DisableMessageSearchIndex(ctx context.Context, vacuum bool) (freedPages int64, err error) {
	s.msgIndex.Store(messageIndexOff)
	if stop := s.msgIndexStop.Swap(nil); stop != nil {
		(*stop)()
	}
	for _, q := range []string{
		`DROP TRIGGER IF EXISTS board_messages_fts_ai`,
		`DROP TRIGGER IF EXISTS board_messages_fts_ad`,
		`DROP TRIGGER IF EXISTS board_messages_fts_au`,
		`DROP TABLE IF EXISTS ` + messageFTSTable,
		`DROP TABLE IF EXISTS ` + messageFTSMeta,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return 0, fmt.Errorf("%s: %w", firstWords(q), err)
		}
	}
	_ = s.db.GetContext(ctx, &freedPages, `PRAGMA freelist_count`)
	if vacuum {
		if _, err := s.db.ExecContext(ctx, `VACUUM`); err != nil {
			return freedPages, fmt.Errorf("vacuum: %w", err)
		}
	}
	return freedPages, nil
}

// messageFTSQuery is the index query for a needle: its distinct trigrams ANDed (each quoted, a quote doubled), or false for a needle of
// fewer than three characters. The index folds the case of what it indexes and of each term the same way.
func messageFTSQuery(text string) (string, bool) {
	r := []rune(text)
	if len(r) < 3 {
		return "", false
	}
	seen := map[string]bool{}
	var terms []string
	for i := 0; i+3 <= len(r) && len(terms) < messageFTSMaxTerms; i++ {
		g := string(r[i : i+3])
		if seen[g] {
			continue
		}
		seen[g] = true
		terms = append(terms, `"`+strings.ReplaceAll(g, `"`, `""`)+`"`)
	}
	return strings.Join(terms, " AND "), true
}

// guardsClear reports whether no message has what LIKE and Go's match disagree on for this needle (from the counts the triggers keep).
func (s *Store) messageIndexGuardsClear(ctx context.Context, text string) (bool, error) {
	var nul, ik int64
	row := s.reader().QueryRowxContext(ctx, `SELECT nul, ik FROM `+messageFTSMeta+` WHERE id = 1`)
	if err := row.Scan(&nul, &ik); err != nil {
		return false, err
	}
	if nul > 0 {
		return false, nil
	}
	if strings.ContainsAny(text, "ik") && ik > 0 {
		return false, nil
	}
	return true, nil
}

// queryTextViaIndex answers a text search from the message search index (message_fts.go): the messages the index offers as candidates,
// each asked LIKE as before. ok is false when the index cannot answer (it is not ready, the needle is under three characters, a message
// holds what LIKE and Go's match disagree on, or the index table is gone) and the caller answers as it does without one.
func (s *Store) queryTextViaIndex(ctx context.Context, q *MessageQuery, where []string, args []any, dir string) (*MessageQueryResult, bool, error) {
	if s.msgIndex.Load() != messageIndexReady {
		return nil, false, nil
	}
	expr, ok := messageFTSQuery(q.Text)
	if !ok {
		return nil, false, nil
	}
	clear, err := s.messageIndexGuardsClear(ctx, q.Text)
	if err != nil || !clear {
		return nil, false, nil // a missing table or a count above zero: the scan answers
	}
	var offered int
	if err := s.reader().GetContext(ctx, &offered, `SELECT COUNT(*) FROM (SELECT rowid FROM `+messageFTSTable+` WHERE `+messageFTSTable+` MATCH ? LIMIT ?)`, expr, messageFTSMaxCandidates); err != nil {
		return nil, false, nil // a missing table: the scan answers
	}
	if offered >= messageFTSMaxCandidates {
		return nil, false, nil
	}
	w := " WHERE " + strings.Join(where, " AND ")
	idArgs := append(append([]any{}, args...), expr, "%"+likeEscaper.Replace(q.Text)+"%")
	var ids []int64
	if err := s.reader().SelectContext(ctx, &ids, "SELECT m.id FROM board_messages m"+w+` AND m.id IN (SELECT rowid FROM `+messageFTSTable+` WHERE `+messageFTSTable+` MATCH ?) AND m.content LIKE ? ESCAPE '\' ORDER BY m.id `+dir, idArgs...); err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return nil, false, nil
		}
		return nil, false, err
	}
	s.msgIndexAnswers.Add(1)
	res, err := s.pageOfIDs(ctx, q, ids)
	if err != nil {
		return nil, false, err
	}
	return res, true, nil
}
