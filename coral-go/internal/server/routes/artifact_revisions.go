package routes

import (
	"sync"

	"github.com/subgentic/coral/internal/board"
)

// The filesystem writers also serve pasted images and auto-attached files,
// outside a handler. Bind their Coral data directory to its board store without
// measuring or scanning the upload store. Test servers use separate directories.
var artifactRevisionStores sync.Map

func bindArtifactRevisions(dir string, bs *board.Store) {
	if dir != "" && bs != nil {
		artifactRevisionStores.Store(dir, bs)
	}
}

func noteArtifactRecordChanged(dir, team string) {
	if v, ok := artifactRevisionStores.Load(dir); ok {
		v.(*board.Store).NoteArtifactsChanged(team)
	}
}
