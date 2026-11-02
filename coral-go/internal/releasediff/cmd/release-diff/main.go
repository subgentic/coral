// Command release-diff prints, as Markdown for a release's "For Coral Hub" note, what changed between two refs of this repository in the tunnel's route table (added, removed and changed routes
// with their tier) and in the board settings keys (HealthSettings included). It reads the route census goldens and the Go source of internal/board with git; it builds and runs nothing of either
// ref (#12331):
//
//	go run ./internal/releasediff/cmd/release-diff [-repo DIR] v2.0.34 v2.0.35
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/subgentic/coral/internal/releasediff"
)

func main() {
	repo := flag.String("repo", ".", "a directory inside the repository")
	flag.Usage = func() { fmt.Fprintln(os.Stderr, "usage: release-diff [-repo DIR] OLD-REF NEW-REF") }
	flag.Parse()
	if flag.NArg() != 2 {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*repo, flag.Arg(0), flag.Arg(1)); err != nil {
		fmt.Fprintln(os.Stderr, "release-diff:", err)
		os.Exit(1)
	}
}

func run(repo, oldRef, newRef string) error {
	for _, r := range []string{oldRef, newRef} {
		if _, err := releasediff.Resolve(repo, r); err != nil {
			return err
		}
	}
	o, n := releasediff.Reader{Repo: repo, Ref: oldRef}, releasediff.Reader{Repo: repo, Ref: newRef}
	or, err := o.Routes()
	if err != nil {
		return fmt.Errorf("%s: %w", oldRef, err)
	}
	nr, err := n.Routes()
	if err != nil {
		return fmt.Errorf("%s: %w", newRef, err)
	}
	os_, err := o.Settings()
	if err != nil {
		return fmt.Errorf("%s: %w", oldRef, err)
	}
	ns, err := n.Settings()
	if err != nil {
		return fmt.Errorf("%s: %w", newRef, err)
	}
	releasediff.WriteRoutes(os.Stdout, releasediff.Compare(or, nr), oldRef, newRef)
	fmt.Println()
	releasediff.WriteSettings(os.Stdout, releasediff.Compare(os_, ns), oldRef, newRef)
	return nil
}
