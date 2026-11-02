package board

// The Operator's decisions about skills (#12129): the Activity record keeps them for a year with the rest, where skills_log holds the agents' search and get rows too and trims them by count. item_kind is "skill", the
// item is the skill's id, the version the digest the Operator acted on.
const (
	ActSkillApprove    = "skill_approve"
	ActSkillReject     = "skill_reject"
	ActSkillRemove     = "skill_remove"
	ActSkillImport     = "skill_import"      // the Operator's own skill, published at once
	ActSkillScriptsAck = "skill_scripts_ack" // the second click: the scripts and files that cannot be shown as text were read
	ActSkillSecretAck  = "skill_secret_ack"  // a file that looks like a key or token goes in anyway (the note names the file, never the secret)
)

// ItemSkill is the item_kind of these rows.
const ItemSkill = "skill"
