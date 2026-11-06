//go:build windows

// coral-heavy-run runs on the mini (macOS or Linux); there is nothing to do on Windows.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "coral-heavy-run is for the mini (macOS or Linux), not Windows")
	os.Exit(125)
}
