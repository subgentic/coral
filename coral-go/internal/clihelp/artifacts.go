package clihelp

import (
	"encoding/json"
	"fmt"
	"os"
)

// ArtifactManifestExample is the smallest --artifacts file: a JSON array with one artifact.
const ArtifactManifestExample = `[{"name":"report","uri":"coral://artifacts/<digest>"}]`

// ReadArtifactManifest reads an --artifacts file: a JSON array of artifacts, each with a name and a uri or content. Its errors say what the file must hold, with
// an example, because an agent that passed an object or a file that does not exist was told only Go's decoding error (eval #577).
func ReadArtifactManifest(path string) ([]map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%v\n--artifacts takes a JSON file holding an array of artifacts (name, and uri or content), e.g. %s", err, ArtifactManifestExample)
	}
	var artifacts []map[string]any
	if err := json.Unmarshal(data, &artifacts); err != nil {
		return nil, fmt.Errorf("--artifacts %s must hold a JSON array of artifacts (name, and uri or content), e.g. %s (%v)", path, ArtifactManifestExample, err)
	}
	return artifacts, nil
}
