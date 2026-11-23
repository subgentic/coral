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

// UnbindArtifactRevisions drops dir's entry when it is still bs, as the server that bound it closes (#20892): the table lives as long as the process, and a store left in it is kept with everything its callbacks reach (the
// handlers, routers and templates of a server that has closed). A later server on the same folder has replaced the entry and keeps it.
func UnbindArtifactRevisions(dir string, bs *board.Store) {
	if dir != "" && bs != nil {
		artifactRevisionStores.CompareAndDelete(dir, bs)
	}
}

func noteArtifactRecordChanged(dir, team string) {
	if v, ok := artifactRevisionStores.Load(dir); ok {
		v.(*board.Store).NoteArtifactsChanged(team)
	}
}
