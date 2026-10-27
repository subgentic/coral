package routes

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sidecarTestItem(id string) *teamArtifact {
	return &teamArtifact{Name: id, managed: id}
}

func writeSidecarAt(t *testing.T, path, body string, age time.Duration) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

// The list does not re-read a settled sidecar, but it sees a rewrite of the same size (the mtime differs), a deleted blob and a fresh
// sidecar written within the settle window (#9535).
func TestEnrichSidecarCacheSeesRewritesAndDeletes(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("ab", 32)
	blob := filepath.Join(dir, id)
	if err := os.WriteFile(blob, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	meta := blob + ".json"
	writeSidecarAt(t, meta, `{"name":"one.txt","media_type":"text/plain"}`, time.Hour)
	it := sidecarTestItem(id)
	it.Name = id // a digest-like name takes the sidecar's
	enrichTeamArtifact(it, dir)
	if it.Name != "one.txt" || it.MediaType != "text/plain" || !it.Available {
		t.Fatalf("first read: %+v", it)
	}
	sidecarMetaCache.Lock()
	_, cached := sidecarMetaCache.m[meta]
	sidecarMetaCache.Unlock()
	if !cached {
		t.Fatal("a settled sidecar is kept")
	}

	// Same size, different mtime: seen.
	writeSidecarAt(t, meta, `{"name":"two.txt","media_type":"text/plain"}`, 30*time.Minute)
	it = sidecarTestItem(id)
	it.Name = id
	enrichTeamArtifact(it, dir)
	if it.Name != "two.txt" {
		t.Fatalf("a same-size rewrite is seen, got %q", it.Name)
	}

	// Written just now: seen.
	writeSidecarAt(t, meta, `{"name":"six.txt","media_type":"text/plain"}`, 0)
	it = sidecarTestItem(id)
	it.Name = id
	enrichTeamArtifact(it, dir)
	if it.Name != "six.txt" {
		t.Fatalf("a fresh rewrite is seen, got %q", it.Name)
	}

	// A deleted blob reads unavailable even though its sidecar is cached.
	writeSidecarAt(t, meta, `{"name":"two.txt","media_type":"text/plain"}`, time.Hour)
	it = sidecarTestItem(id)
	enrichTeamArtifact(it, dir)
	if !it.Available {
		t.Fatal("blob present")
	}
	if err := os.Remove(blob); err != nil {
		t.Fatal(err)
	}
	it = sidecarTestItem(id)
	enrichTeamArtifact(it, dir)
	if it.Available || it.Size != nil {
		t.Fatalf("a deleted blob is unavailable: %+v", it)
	}
}

func TestSidecarCacheIsBounded(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < maxSidecarMetaEntries+50; i++ {
		p := filepath.Join(dir, fmt.Sprintf("%d.json", i))
		writeSidecarAt(t, p, `{"name":"n"}`, time.Hour)
		if _, ok := readArtifactSidecar(p); !ok {
			t.Fatal("read")
		}
	}
	sidecarMetaCache.Lock()
	n := len(sidecarMetaCache.m)
	sidecarMetaCache.Unlock()
	if n > maxSidecarMetaEntries {
		t.Fatalf("the cache holds %d entries, over %d", n, maxSidecarMetaEntries)
	}
}
