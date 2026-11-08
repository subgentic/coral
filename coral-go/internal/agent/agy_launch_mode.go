package agent

import "strings"

// AgyLaunchMode is the one mode an agy launch with these stored settings starts in, as one of "skip" (nothing asks), "auto", "accept-edits", "plan" or "default" (asks first). It takes the same steps
// the launch builder takes (the Operator's keep-Full-access choice first, then the capabilities narrowing an explicit mode, then the stored flags, then the mode), and
// TestAgyLaunchModeAgreesWithTheLaunchBuilder keeps the two together (#14085). With nil capabilities it is the mode the person chose, before any narrowing.
func AgyLaunchMode(flags []string, caps *Capabilities, mode string, keepFullAccess bool) string {
	if keepFullAccess {
		return "skip"
	}
	if caps != nil && !caps.IsEmpty() {
		perms := TranslateToAgyPermissions(caps)
		if rank, ok := agyRankForMode(mode); ok {
			perms = narrowAgyPermissions(perms, rank)
		}
		return agyModeWord(agyRankOf(perms))
	}
	for i := 0; i < len(flags); i++ {
		f := flags[i]
		switch {
		case f == "--yolo" || f == "--dangerously-skip-permissions":
			return "skip"
		case f == "--mode" && i+1 < len(flags):
			return agyModeWordOfMode(flags[i+1])
		case strings.HasPrefix(f, "--mode="):
			return agyModeWordOfMode(strings.TrimPrefix(f, "--mode="))
		case f == "--permission-mode" && i+1 < len(flags):
			return agyWordOfGeneric(flags[i+1])
		case strings.HasPrefix(f, "--permission-mode="):
			return agyWordOfGeneric(strings.TrimPrefix(f, "--permission-mode="))
		default:
			if value, ok := agyApprovalModeValue(flags, &i); ok {
				if generic, known := agyLegacyApprovalModes[value]; known {
					return agyWordOfGeneric(generic)
				}
			}
		}
	}
	return agyWordOfGeneric(mode)
}

func agyModeWord(rank int) string {
	switch rank {
	case agyRankSkip:
		return "skip"
	case agyRankAcceptEdits:
		return "accept-edits"
	case agyRankAuto:
		return "auto"
	case agyRankPlan:
		return "plan"
	}
	return "default"
}

func agyWordOfGeneric(mode string) string {
	if rank, ok := agyRankForMode(mode); ok {
		return agyModeWord(rank)
	}
	return "default"
}

func agyModeWordOfMode(mode string) string {
	switch mode {
	case "accept-edits":
		return "accept-edits"
	case "auto":
		return "auto"
	case "plan":
		return "plan"
	}
	return "default"
}
