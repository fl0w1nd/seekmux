package config

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// RateLimit allows Requests calls per sliding Window. Zero requests means unlimited.
type RateLimit struct {
	Requests int
	Window   time.Duration
}

var rateLimitPattern = regexp.MustCompile(`^(\d+)/(\d*)(s|m|h)$`)

var rateLimitUnits = map[string]time.Duration{"s": time.Second, "m": time.Minute, "h": time.Hour}

// ParseRateLimit parses "1/s", "15/m", "10/10s" or "100/2h". An empty string
// means unlimited.
func ParseRateLimit(value string) (RateLimit, error) {
	if value == "" {
		return RateLimit{}, nil
	}
	m := rateLimitPattern.FindStringSubmatch(value)
	if m == nil {
		return RateLimit{}, fmt.Errorf(`invalid rate limit %q, expected e.g. "1/s", "15/m", "10/10s"`, value)
	}
	requests, _ := strconv.Atoi(m[1])
	multiplier := 1
	if m[2] != "" {
		multiplier, _ = strconv.Atoi(m[2])
	}
	if requests <= 0 || multiplier <= 0 {
		return RateLimit{}, fmt.Errorf("invalid rate limit %q: numbers must be positive", value)
	}
	return RateLimit{Requests: requests, Window: time.Duration(multiplier) * rateLimitUnits[m[3]]}, nil
}
