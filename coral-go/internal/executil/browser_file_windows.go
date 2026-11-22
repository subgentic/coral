package executil

import "golang.org/x/sys/windows/registry"

func defaultBrowserID() (string, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`, registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer k.Close()
	id, _, err := k.GetStringValue("ProgId")
	return id, err
}
