package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvironmentOverlayIsAuthoritativeButNotPersisted(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	databasePath := filepath.Join(dir, "environment.db")
	t.Setenv(EnvironmentPrefix+"SETTINGS_PATH", settingsPath)
	t.Setenv(EnvironmentPrefix+"INSTANCE_NAME", "Living room")
	t.Setenv(EnvironmentPrefix+"DATABASE_PATH", databasePath)
	t.Setenv(EnvironmentPrefix+"TRUSTED_CIDRS", "127.0.0.0/8, 192.168.50.0/24")

	store, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get(); got.InstanceName != "Living room" || got.DatabasePath != databasePath || len(got.TrustedCIDRs) != 2 {
		t.Fatalf("environment overlay was not applied: %#v", got)
	}
	if !store.EnvironmentManaged("instanceName") || !store.EnvironmentManaged("databasePath") {
		t.Fatal("environment-managed settings were not exposed")
	}

	next := store.Get()
	next.InstanceName = "Browser edit"
	if err := store.Save(next); err != nil {
		t.Fatal(err)
	}
	if store.Get().InstanceName != "Living room" {
		t.Fatal("an environment-managed setting was overwritten")
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "Living room") || strings.Contains(string(data), databasePath) {
		t.Fatalf("environment values leaked into persisted settings: %s", data)
	}
}

func TestCamelToEnvironmentKeepsReadableSettingNames(t *testing.T) {
	for input, want := range map[string]string{
		"fileListPasskey": "FILE_LIST_PASSKEY",
		"qbittorrentUrl":  "QBITTORRENT_URL",
		"tmdbApiKey":      "TMDB_API_KEY",
	} {
		if got := camelToEnvironment(input); got != want {
			t.Errorf("camelToEnvironment(%q) = %q, want %q", input, got, want)
		}
	}
}
