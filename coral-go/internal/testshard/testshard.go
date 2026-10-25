// Package testshard lets one package's tests run as several test processes at once (tools/go_test_shard.py): a package whose tests run one
// after another, as internal/server/routes does, sets the wall time of the whole suite, and its tests are isolated per process.
//
// The package's TestMain calls Apply before m.Run. With CORAL_TEST_SHARD_LIST unset (a plain go test) it does nothing; with it set to a
// file of test names, one per line, only those tests run. The names go through a file, not -run, because the list of a big package is longer
// than a Windows command line.
package testshard

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// ListEnv names the file of test names this process runs.
const ListEnv = "CORAL_TEST_SHARD_LIST"

// Apply narrows the test binary to the names in the file ListEnv points to. It must run after the testing flags are parsed (in a TestMain
// that has called flag.Parse, or before m.Run, which parses them): it sets -test.run itself.
func Apply() error {
	path := os.Getenv(ListEnv)
	if path == "" {
		return nil
	}
	if !flag.Parsed() {
		flag.Parse()
	}
	if f := flag.Lookup("test.run"); f != nil && f.Value.String() != "" {
		return errors.New("testshard: " + ListEnv + " and -run both select tests; use one")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("testshard: %w", err)
	}
	var names []string
	for _, n := range strings.Fields(string(raw)) {
		names = append(names, regexp.QuoteMeta(n))
	}
	if len(names) == 0 {
		return errors.New("testshard: " + path + " lists no test")
	}
	return flag.Set("test.run", "^("+strings.Join(names, "|")+")$")
}
