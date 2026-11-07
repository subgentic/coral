package tunnel

import (
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestArtifactThumbnailScope(t *testing.T) {
	path := "/api/artifacts/" + strings.Repeat("a", 64) + "/thumbnail"
	require.Equal(t, TierView, Classify("GET", path, ""))
	_, mode := OwnerRoute("GET", path)
	require.Equal(t, OwnerRefuse, mode)
	require.False(t, IsGuideRoute("GET", path))
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		require.Equal(t, TierNever, Classify(method, path, ""))
	}
	require.Equal(t, TierNever, Classify("GET", path, "width=10000"))
	require.Equal(t, TierNever, Classify("GET", "/api/artifacts/"+strings.Repeat("a", 63)+"/thumbnail", ""))
}
