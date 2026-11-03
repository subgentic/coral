package startup

import (
	"context"
	"log"
	"path/filepath"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/dataowner"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// dataOwnerProbe is what internal/dataowner reads and writes in this folder and database.
func dataOwnerProbe(db *store.DB, dir string) dataowner.Probe {
	return dataowner.Probe{
		Dir:       filepath.Clean(dir),
		Marker:    db.DataDirID,
		SetMarker: db.SetDataDirID,
	}
}

// verifyDataOwner decides, once per start, whether the database is this data folder's own (internal/dataowner).
func verifyDataOwner(ctx context.Context, db *store.DB, dir string) dataowner.Verdict {
	return dataowner.Verify(ctx, dataOwnerProbe(db, dir))
}

// settleDataOwner is the start's answer to "is this database this folder's own?" (internal/dataowner). Coral never blocks on it (#12591: v2.0.37 withheld everything from the operator's own agents after
// judging their real folder a copy): whatever the verdict, delivery, recovery, auto-wake, auto-sleep and the health check run as usual, so the foreign flag is always cleared. When the ids show a copy (they
// differ, or another existing folder holds the same id) one WARN is logged and the dashboard shows a warning with "This is my data folder", which adopts the folder in place; nothing waits on that click. A
// folder with no id gets its id, silently.
func settleDataOwner(ctx context.Context, db *store.DB, dir string) dataowner.Verdict {
	v := verifyDataOwner(ctx, db, dir)
	ptymanager.SetForeign(false)
	if v.Foreign {
		log.Print(dataowner.LogLine(v))
		dataowner.SetCopyWarning(dataowner.Notice, func(ctx context.Context) error { return AdoptDataDir(ctx, db, dir) })
	}
	return v
}

// AdoptDataDirCommand is coral --adopt-data-dir: it opens the databases of cfg's data folder (the caller holds the instance lock, so no other Coral runs there), gives them a new id in the
// database and in the folder, and returns. It starts no server and wakes nothing.
func AdoptDataDirCommand(ctx context.Context, cfg *config.Config, opts Options) error {
	coralDir := cfg.CoralDir()
	boardPath := filepath.Join(coralDir, "messageboard.db")
	security, dbKey, err := resolveDatabaseKey(cfg, coralDir, boardPath, opts)
	if err != nil {
		return err
	}
	db, err := openDatabases(ctx, cfg, boardPath, dbKey, security)
	if err != nil {
		return err
	}
	defer db.Close()
	return AdoptDataDir(ctx, db, coralDir)
}

// AdoptDataDir makes the database at the given path this folder's own: a new id in the database and in the folder. The operator's action (coral --adopt-data-dir, with Coral stopped); it starts
// nothing and wakes nothing.
func AdoptDataDir(ctx context.Context, db *store.DB, dir string) error {
	return dataowner.Adopt(ctx, dataOwnerProbe(db, dir))
}
