package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func socialDoc(t *testing.T, social string) *Config {
	t.Helper()
	var c Config
	doc := `{"fetchers": [{"id": "home", "type": "opencli", "name": "Home", "workers": [
		{"id": "w1", "name": "Laptop", "enabled": true, "token": "t1"},
		{"id": "w2", "name": "Desktop", "enabled": false, "token": "t2"}]}]` + social + `}`
	if err := json.Unmarshal([]byte(doc), &c); err != nil {
		t.Fatal(err)
	}
	c.Normalize()
	return &c
}

func TestSocialIsEmptyInADocumentFromBeforeIt(t *testing.T) {
	c := socialDoc(t, "")
	if c.Social.Sources == nil || len(c.Social.Sources) != 0 || c.Social.TimeoutSeconds != 45 {
		t.Fatalf("social = %+v", c.Social)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if c.SocialAvailable(PlatformX) {
		t.Fatal("X must not be available without a source")
	}
}

func TestSocialSourceFollowsItsFetcher(t *testing.T) {
	c := socialDoc(t, `, "social": {"sources": [{"platform": "x", "enabled": true, "fetcher": "home", "workers": ["w2", "gone", "w1", "w1"]}]}`)
	src, _ := c.SocialSource(PlatformX)
	if strings.Join(src.Workers, ",") != "w2,w1" {
		t.Fatalf("workers = %v: unknown and repeated workers must be dropped", src.Workers)
	}
	f, workers, ok := c.SourceWorkers(PlatformX)
	if !ok || f.ID != "home" || len(workers) != 1 || workers[0].ID != "w1" {
		t.Fatalf("source workers = %v %v %v: only switched-on workers, in the fetcher's order", f, workers, ok)
	}
	if !c.SocialAvailable(PlatformX) {
		t.Fatal("X must be available")
	}

	// Removing the fetcher leaves the source without one, and the document valid.
	c.Fetchers = nil
	c.Normalize()
	src, _ = c.SocialSource(PlatformX)
	if src.Fetcher != "" || len(src.Workers) != 0 || c.SocialAvailable(PlatformX) {
		t.Fatalf("source = %+v", src)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestSocialRefusesUnknownAndRepeatedPlatforms(t *testing.T) {
	c := socialDoc(t, `, "social": {"sources": [{"platform": "myspace"}]}`)
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "unknown platform") {
		t.Fatalf("err = %v", err)
	}
	c = socialDoc(t, `, "social": {"sources": [{"platform": "x"}, {"platform": "x"}]}`)
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "twice") {
		t.Fatalf("err = %v", err)
	}
}
