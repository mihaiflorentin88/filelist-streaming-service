package config

import (
	"encoding/json"
	"math"
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

func TestAllocationAndReserveRoundTripFileAndFractionalValues(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	t.Setenv(EnvironmentPrefix+"SETTINGS_PATH", settingsPath)
	t.Setenv(EnvironmentPrefix+"DATABASE_PATH", filepath.Join(dir, "retention.db"))
	file := Defaults()
	file.AllocationGB = 0.5
	file.ReserveGB = 8
	b, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get(); got.AllocationGB != 0.5 || got.ReserveGB != 8 {
		t.Fatalf("gigabyte settings did not survive the file round-trip: %#v", got)
	}
}

func TestAllocationEnvironmentOverrideWinsAndNeverPersists(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	t.Setenv(EnvironmentPrefix+"SETTINGS_PATH", settingsPath)
	t.Setenv(EnvironmentPrefix+"DATABASE_PATH", filepath.Join(dir, "retention.db"))
	file := Defaults()
	file.AllocationGB = 0.5
	b, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvironmentPrefix+"ALLOCATION_GB", "25")
	store, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get(); got.AllocationGB != 25 {
		t.Fatalf("environment allocation override lost: %#v", got)
	}
	if !store.EnvironmentManaged("allocationGb") {
		t.Fatal("allocationGb was not reported environment-managed")
	}
	next := store.Get()
	next.ReserveGB = 9
	if err := store.Save(next); err != nil {
		t.Fatal(err)
	}
	if store.Get().AllocationGB != 25 {
		t.Fatal("an environment-managed allocation was overwritten")
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "25") || !strings.Contains(string(data), `"allocationGb": 0.5`) {
		t.Fatalf("environment allocation leaked into persisted settings: %s", data)
	}
}

func TestAllocationAndReserveRangeValidation(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvironmentPrefix+"SETTINGS_PATH", filepath.Join(dir, "settings.json"))
	t.Setenv(EnvironmentPrefix+"DATABASE_PATH", filepath.Join(dir, "retention.db"))
	store, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name                string
		allocation, reserve float64
		ok                  bool
	}{{"zero disables", 0, 0, true}, {"fractional", 0.5, 8, true}, {"range floor", 0.1, 0.1, true}, {"range ceiling", 100000, 100000, true}, {"negative", -1, 8, false}, {"below floor", 0.05, 8, false}, {"absurd ceiling", 100001, 8, false}, {"not a number", math.NaN(), 8, false}} {
		next := store.Get()
		next.AllocationGB = tt.allocation
		next.ReserveGB = tt.reserve
		err := store.Save(next)
		if tt.ok && err != nil {
			t.Errorf("%s: unexpected error %v", tt.name, err)
		}
		if !tt.ok && err == nil {
			t.Errorf("%s: accepted invalid retention settings", tt.name)
		}
	}
}
