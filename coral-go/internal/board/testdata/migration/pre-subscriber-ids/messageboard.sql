-- Synthetic upgrade fixture for the pre-subscriber-ID core-table layout.
-- Unlike the released v1.4.80/v1.4.110 dumps, none of the destination columns
-- needed by the subscriber backfill exist. No released dump is modified.
CREATE TABLE board_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    job_title TEXT NOT NULL,
    webhook_url TEXT,
    origin_server TEXT,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    subscribed_at TEXT NOT NULL,
    UNIQUE(project, session_id)
);
CREATE TABLE board_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE board_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    group_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    UNIQUE(project, group_id, session_id)
);
INSERT INTO board_subscribers (id, project, session_id, job_title, last_read_id, subscribed_at) VALUES
    (1, 'alpha', 'old-shell-1', 'Builder', 7, '2025-01-01T00:00:00Z'),
    (2, 'alpha', 'old-shell-2', 'Reviewer', 9, '2025-01-02T00:00:00Z'),
    (3, 'beta',  'old-shell-1', 'Other Role', 3, '2025-01-03T00:00:00Z');
INSERT INTO board_messages VALUES
    (1, 'alpha', 'old-shell-1', 'retained builder post', '2025-01-01T01:00:00Z'),
    (2, 'alpha', 'departed-shell', 'retained departed post', '2025-01-01T02:00:00Z'),
    (3, 'beta', 'old-shell-1', 'retained other-board post', '2025-01-01T03:00:00Z');
INSERT INTO board_groups VALUES
    (1, 'alpha', 'workers', 'old-shell-2'),
    (2, 'beta', 'workers', 'old-shell-1'),
    (3, 'alpha', 'workers', 'departed-shell');
