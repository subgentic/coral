package runrecord

// This package's tests can name a Coral's address, so their binary links the test guard: in a test binary it refuses a dial to the live Coral (a default port, 8420 or 8450, an
// inherited CORAL_URL, the port in the real lock file) and drops the agent shell's tmux (internal/testguard; census: TestEveryTestPackageThatCanNameACoralAddressLinksTestguard).
import _ "github.com/subgentic/coral/internal/testguard"
