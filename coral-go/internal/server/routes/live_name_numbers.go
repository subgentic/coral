package routes

import (
	"strings"
)

// numberUnnamedDuplicates gives each live row a "name_number" (#10249): 1 for an agent whose name is its own, and 2, 3, ... for the later agents that would otherwise show the same default name as an earlier
// one ("Claude" twice in the home folder, the folder's name twice, two folders of one name). An agent nobody named is called by its folder, else its CLI; two with the same default were told apart by nothing
// (Mobile #10198). The dashboard draws "<name> 2" in every place it names the agent, so a duplicate reads the same in the list, the toast, the Inbox row and the header; a person's own rename (display_name) or a
// board job title is a name and wins, a terminal is not an agent in this sense, and an archived row is not counted. The rows are already in their stable list order (orderLiveRows), so the first keeps the plain
// name and a later one keeps its number while the earlier ones live. The field is on every row, 1 included: the dashboard merges rows, and an omitted field would leave an old number on.
func numberUnnamedDuplicates(rows []map[string]any, coralRoot string) {
	groups := map[string][]int{}
	for i, row := range rows {
		row["name_number"] = 1
		agentType, _ := row["agent_type"].(string)
		if archived, _ := row["archived"].(bool); archived || agentType == "terminal" {
			continue
		}
		if rowText(row["display_name"]) != "" || rowText(row["board_job_title"]) != "" {
			continue
		}
		dir, _ := row["working_directory"].(string)
		key := defaultNameKey(dir, agentType, coralRoot)
		groups[key] = append(groups[key], i)
	}
	for _, idx := range groups {
		for n, i := range idx {
			if n > 0 {
				rows[i]["name_number"] = n + 1
			}
		}
	}
}

// rowText is a row field that is a string, a *string or nil, trimmed.
func rowText(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case *string:
		if t != nil {
			return strings.TrimSpace(*t)
		}
	}
	return ""
}

// defaultNameKey is what the dashboard's default name is made of (session_state.js defaultAgentName): the working folder's own name unless it is the home folder (Coral's root), the root or a drive, else the CLI.
func defaultNameKey(dir, agentType, coralRoot string) string {
	trim := func(p string) string { return strings.TrimRight(strings.TrimSpace(p), `/\`) }
	d, root := trim(dir), trim(coralRoot)
	if d != "" && d != "~" && d != root && !(len(d) == 2 && d[1] == ':') {
		if i := strings.LastIndexAny(d, `/\`); i >= 0 {
			d = d[i+1:]
		}
		if d != "" {
			return "dir:" + strings.ToLower(d)
		}
	}
	return "type:" + agentType
}
