//go:build windows

// coral-heavy-run runs on a remote machine of the pool (macOS or Linux); there is nothing to do on Windows.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "coral-heavy-run is for a remote machine of the pool (macOS or Linux), not Windows")
	os.Exit(125)
}
