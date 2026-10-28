package main

import "errors"

// machineUserData makes the cloud-init user-data for one machine credential: the Coral release to install, the cap the machine announces, and the agent CLIs (name or name@version). It is the one
// seam between this command and the user-data builder of #9973 (slice 1, part 3: machinelaunch.BuildUserData); until that is in this build it says so instead of making something up.
var machineUserData = func(credential, maxMode, coralVersion string, agents []string) (string, error) {
	return "", errors.New("this build cannot make the machine's user-data yet (the builder of #9973 slice 1 part 3 is not in it)")
}
