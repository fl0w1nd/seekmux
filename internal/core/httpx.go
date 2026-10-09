package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 32 << 20

// HTTPError is a non-2xx answer from a provider.
// Class says what an upstream error is about, which decides whether to
// retry, whether it counts against the provider's health, and for how long.
type Class string

const (
	// ClassRateLimit is a short-term limit: wait and retry.
	ClassRateLimit Class = "rate_limit"
	// ClassQuota is exhausted credits or a billing problem: retrying is
	// pointless until the account changes.
	ClassQuota Class = "quota"
	// ClassAuth is a rejected API key or missing permission.
	ClassAuth Class = "auth"
	// ClassBadRequest is a request the provider will never accept.
	ClassBadRequest Class = "bad_request"
	// ClassTarget is a failure of the page being fetched, not of the provider.
	ClassTarget Class = "target"
	// ClassProvider is the provider itself failing.
	ClassProvider Class = "provider"
)

type HTTPError struct {
	Provider   string
	StatusCode int
	Body       string
	RetryAfter time.Duration
	HasRetry   bool
	// Class overrides what the status code alone says; see Kind.
	Class Class
	// DisableFor is when the provider says it becomes usable again, such as a
	// monthly quota resetting; zero when it does not say.
	DisableFor time.Duration
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s API error: %d %s", e.Provider, e.StatusCode, e.Body)
}

// Kind returns the class of the error: the one a provider-specific rule set,
// or else what the status code conventionally means.
func (e *HTTPError) Kind() Class {
	switch {
	case e.Class != "":
		return e.Class
	case e.StatusCode == http.StatusTooManyRequests:
		return ClassRateLimit
	case e.StatusCode == http.StatusPaymentRequired:
		return ClassQuota
	case e.StatusCode == http.StatusUnauthorized:
		return ClassAuth
	case e.StatusCode == http.StatusForbidden:
		// Ambiguous: a revoked key, but just as well a firewall or a region
		// rule in front of the API. Only a provider's own rule may call it an
		// account problem, since those switch the provider off for good.
		return ClassProvider
	case e.StatusCode == http.StatusRequestTimeout, e.StatusCode >= 500:
		return ClassProvider
	}
	return ClassBadRequest
}

// TargetError reports that a provider answered but could not get the page:
// the site refused, was missing or returned nothing usable.
type TargetError struct{ Provider, Reason string }

func (e *TargetError) Error() string { return e.Provider + " could not get the page: " + e.Reason }

// TimeoutError reports that a tool call ran out of its time budget.
type TimeoutError struct{ Timeout time.Duration }

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("Timeout (%ds)", int(math.Round(e.Timeout.Seconds())))
}

// Retryable reports whether calling the same provider again can help.
func Retryable(err error) bool {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		kind := httpErr.Kind()
		return (kind == ClassRateLimit || kind == ClassProvider) && httpErr.StatusCode != http.StatusForbidden
	}
	var timeout *TimeoutError
	var target *TargetError
	if errors.As(err, &timeout) || errors.As(err, &target) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return err != nil
}

// RetryAfter returns the delay a provider asked for, if any.
func RetryAfter(err error) (time.Duration, bool) {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) && httpErr.HasRetry {
		return httpErr.RetryAfter, true
	}
	return 0, false
}

// HTTPStatus returns the status code carried by err, or zero.
func HTTPStatus(err error) int {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode
	}
	return 0
}

func parseRetryAfter(value string) (time.Duration, bool) {
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds >= 0 {
		return time.Duration(seconds * float64(time.Second)), true
	}
	if at, err := http.ParseTime(value); err == nil {
		return max(0, time.Until(at)), true
	}
	return 0, false
}

// Request describes one JSON API call to a provider.
type Request struct {
	Provider string
	Method   string
	URL      string
	Query    url.Values
	Header   map[string]string
	Body     any
	// Classify refines an error response using what this provider documents
	// about its status codes, body and headers.
	Classify func(e *HTTPError, header http.Header)
}

// DoJSON performs the request and decodes a 2xx JSON body into out.
func DoJSON(ctx context.Context, client *http.Client, r Request, out any) error {
	target := r.URL
	if len(r.Query) > 0 {
		target += "?" + r.Query.Encode()
	}
	var body io.Reader
	if r.Body != nil {
		data, err := json.Marshal(r.Body)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	method := r.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range r.Header {
		req.Header.Set(k, v)
	}

	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s request failed: %w", r.Provider, cleanURLError(err))
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode > 299 {
		text, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		retryAfter, has := parseRetryAfter(res.Header.Get("Retry-After"))
		httpErr := &HTTPError{
			Provider:   r.Provider,
			StatusCode: res.StatusCode,
			Body:       strings.TrimSpace(string(text)),
			RetryAfter: retryAfter,
			HasRetry:   has,
		}
		if r.Classify != nil {
			r.Classify(httpErr, res.Header)
		}
		return httpErr
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("%s response read failed: %w", r.Provider, err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s returned invalid JSON: %w", r.Provider, err)
	}
	return nil
}

// cleanURLError strips the request URL from a transport error: it can carry
// the target page and adds nothing the caller does not already know.
func cleanURLError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}
