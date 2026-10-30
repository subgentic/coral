package server

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/dbcrypt"
	"github.com/subgentic/coral/internal/store"
)

// replaceAfterOpenDataDir runs at a start that made the data folder private (config.DataDirMadePrivate, Windows), and finishes that
// protection: Coral renews what it owns. The API key, which also signs out the browser sign-ins kept in sessions.db (so this runs after the
// key store has its session backend), and the agents' session tokens (startup revokes them too, before its sweep removes their files); it
// marks every stored remote server. The command-line token is written new at every start (NewCloudHandler) and a login token lives only in
// memory. The notice then lists what the person may want to renew, each only when it applies.
//
// Only when all three are done is the folder's marker (config.RenewPendingFile) removed: a start that stopped part of the way leaves it,
// and the next start does it all again and says so.
func replaceAfterOpenDataDir(ctx context.Context, dir string, ks *auth.KeyStore, db *store.DB) {
	if !config.DataDirMadePrivate(dir) || ks == nil {
		return
	}
	// Once per start: a later start of the same folder in this process (a restart in place) finds it private, and goes on only if the marker says
	// this start did not finish.
	config.SetDataDirMadePrivate(dir, false)
	f := openFolderFacts{again: config.DataDirNotice() == ""} // EnsureDataDir said nothing: the folder was private already, so an earlier start did not finish
	if _, err := ks.RegenerateKey(); err != nil {
		log.Printf("[security] could not replace the API key after making the data folder private: %v", err)
	} else {
		f.keyReplaced = true
		log.Printf("[security] replaced the API key and ended the browser sign-ins: the data folder was open to other accounts")
	}
	marked := false
	if db != nil {
		if n, err := db.RevokeAllSessionTokens(ctx); err != nil {
			log.Printf("[security] could not revoke the agents' session tokens after making the data folder private: %v", err)
		} else {
			f.tokensRevoked = true
			if n > 0 {
				log.Printf("[security] revoked %d more agent session tokens from before", n)
			}
		}
		rs := store.NewRemoteServerStore(db, dir)
		if n, err := rs.MarkKeysForRenewal(ctx); err != nil {
			log.Printf("[security] could not mark the stored remote servers' keys as readable by others: %v", err)
		} else {
			marked = true
			if n == 1 {
				log.Printf("[security] 1 stored remote server's key could be read by others: Settings > Servers says so until it gets a new key")
			} else if n > 1 {
				log.Printf("[security] %d stored remote servers' keys could be read by others: Settings > Servers says so until each gets a new key", n)
			}
		}
		if list, err := rs.List(ctx); err == nil {
			for _, r := range list {
				name := r.Label
				if name == "" {
					name = r.ID
				}
				f.remotes = append(f.remotes, name)
			}
		}
		if conn, err := store.NewCloudStore(db, rs).Get(ctx); err == nil && conn != nil && conn.State != store.CloudStateRevoked {
			f.hubLinked = true
		} else if err != nil && !errors.Is(err, store.ErrNoCloudConnection) {
			log.Printf("[security] could not read the Coral Hub link for the data folder notice: %v", err)
		}
	}
	f.password = ks.PasswordSet()
	if _, err := os.Lstat(filepath.Join(dir, dbcrypt.KeyName)); err == nil {
		f.dbKey = true
	}
	f.done = f.keyReplaced && f.tokensRevoked && marked
	if f.done {
		if err := config.ClearDataDirRenewal(dir); err != nil {
			log.Printf("[security] the data folder's secrets were replaced, but its marker could not be removed (the next start replaces them again): %v", err)
		}
	} else {
		log.Printf("[security] not everything in the data folder could be replaced: the next start tries again (%s stays)", config.RenewPendingFile)
	}
	config.SetDataDirNotice(strings.TrimSpace(config.DataDirNotice() + " " + openFolderWords(f)))
}

// openFolderFacts is what the notice after an open data folder depends on.
type openFolderFacts struct {
	again         bool // an earlier start found the folder open and did not finish; this start does it again
	done          bool // everything Coral can replace was replaced: the marker is gone
	tokensRevoked bool
	keyReplaced   bool
	remotes       []string // the stored remote Corals, by label (or id)
	hubLinked     bool
	password      bool
	dbKey         bool
}

// openFolderWords is the notice's text after Coral made the data folder private: what Coral renewed, and what is left for the person,
// each only when it applies.
func openFolderWords(f openFolderFacts) string {
	var b strings.Builder
	if f.again {
		b.WriteString("Coral found its data folder had been open to other accounts, and an earlier start did not finish replacing what was in it. ")
	}
	b.WriteString("Until then other accounts on this computer could read what is in it: the conversations and board messages, and the keys and tokens")
	if len(f.remotes) > 0 {
		b.WriteString(", the API keys of the other Corals stored here among them")
	}
	b.WriteString(".")
	if f.keyReplaced {
		b.WriteString(" So Coral replaced the API key: scripts and computers that use it need the new one (coral api-key prints it). Browser sign-ins from before no longer work.")
	} else {
		b.WriteString(" Coral could not replace the API key (coral.log says why), so the old one still works.")
	}
	if f.tokensRevoked {
		b.WriteString(" Agent tokens from before no longer work, so an agent still running from before needs a restart.")
	}
	if !f.done {
		b.WriteString(" Coral tries again at its next start.")
	}
	var left []string
	if len(f.remotes) > 0 {
		// Each by name: a new key for a stored server is made on that server, then entered here.
		names := make([]string, 0, len(f.remotes))
		for _, r := range f.remotes {
			names = append(names, cleanRemoteName(r))
		}
		left = append(left, "the API keys of the other Corals stored here ("+strings.Join(names, ", ")+"): make a new key on each of those computers and enter it here again")
	}
	if f.hubLinked {
		left = append(left, "the Coral Hub link: unlink and link again in Settings > Network and Hub")
	}
	if f.password {
		left = append(left, "the password: set a new one")
	}
	if f.dbKey {
		left = append(left, "the database key (.db_key): it can't be changed without re-encrypting the databases")
	}
	if len(left) > 0 {
		b.WriteString(" Only you can replace the rest: " + strings.Join(left, "; ") + ".")
	}
	return b.String()
}

// cleanRemoteName is a stored label as the notice shows it: printable characters only, at most 40 of them.
func cleanRemoteName(s string) string {
	s = strings.Map(func(r rune) rune {
		if !unicode.IsPrint(r) {
			return -1
		}
		return r
	}, s)
	if r := []rune(s); len(r) > 40 {
		s = string(r[:40]) + "…"
	}
	return s
}
