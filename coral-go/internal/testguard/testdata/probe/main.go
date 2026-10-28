// Command probe prints what testguard says about this process (run by go run in TestAShippedBinaryGivenTestFlagsIsNotATestRun).
package main

import (
	"fmt"

	"github.com/subgentic/coral/internal/testguard"
)

func main() {
	fmt.Printf("InTest=%v InTestRun=%v\n", testguard.InTest(), testguard.InTestRun())
}
