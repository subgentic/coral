package server

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #9084: through the real router, the Hub's authentically stamped service stream reaches the goal-links handler (it was refused by the Guard); a user's stream, a forged stamp and a local program are still
// refused, the first two by the Guard with its closed code and the last by the handler as service_only.
func TestTheHubsServiceReadOfGoalLinksPassesTheGuardAndNobodyElseDoes(t *testing.T) {
	r := newE2ERemote(t, "goallinks", nil)
	h := r.srv.Router()
	const target = "/api/goal-links?request_id=nosuchrequest"
	service := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "alpha"}

	rec := call(h, "GET", target, "", service)
	require.NotContains(t, rec.Body.String(), "not available through the Coral Hub", "the Guard let the service read through: %d %s", rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), "service_only", "and the handler took it as the service's: %d %s", rec.Code, rec.Body.String())

	for name, hdr := range map[string]map[string]string{
		"a user's stream":                     {tunnel.ViaHeader: cloud.ViaSecret()},
		"a forged stamp with service headers": {tunnel.ViaHeader: "1", tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "alpha"},
		"the secret and the flag, no asker":   {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubServiceHeader: "1"},
	} {
		rec = call(h, "GET", target, "", hdr)
		require.Equal(t, 403, rec.Code, name)
		require.Contains(t, rec.Body.String(), `"code":"hub_route_refused"`, name)
	}
	rec = call(h, "GET", target, "", map[string]string{tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "alpha"})
	require.Equal(t, 403, rec.Code, "a local program that sends the service headers")
	require.Contains(t, rec.Body.String(), "service_only")
}
