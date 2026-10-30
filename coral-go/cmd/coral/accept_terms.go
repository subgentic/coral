package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

)

// runAcceptTerms is `coral accept-terms` (#11370): the self-hosted hub, on a computer it sets Coral up on over SSH, passes the acceptance its owner gave in the setup dialog. It is not in the
// command list on purpose, and it takes no argument: the acceptance is JSON on STDIN, {"version", "sha256", "by"}, at most 4 KiB, no other field. It is refused unless the version and the digest are
// exactly this binary's terms. Nothing else in Coral calls it, and a normal first start still asks a person.
func runAcceptTerms(args []string, stdin io.Reader, stdout, stderr io.Writer, record func(version, digest, by string) error) int {
	if len(args) != 0 {
		fmt.Fprintln(stderr, "coral accept-terms: takes no arguments; the acceptance is read from stdin")
		return 2
	}
	data, err := io.ReadAll(io.LimitReader(stdin, 4097))
	if err != nil || len(data) > 4096 {
		fmt.Fprintln(stderr, "coral accept-terms: the acceptance on stdin is missing or too long")
		return 2
	}
	var in struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
		By      string `json:"by"`
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || dec.More() {
		fmt.Fprintln(stderr, "coral accept-terms: stdin is not the acceptance (version, sha256, by)")
		return 2
	}
	if err := record(in.Version, in.SHA256, in.By); err != nil {
		fmt.Fprintln(stderr, "coral accept-terms: refused:", err)
		return 1
	}
	fmt.Fprintf(stdout, "terms %s accepted\n", in.Version)
	return 0
}
