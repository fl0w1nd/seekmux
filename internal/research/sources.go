package research

import (
	"net/url"
	"regexp"
	"strings"
)

// pageKey reduces a URL to what identifies its page, so that a citation
// matches the page it was read from despite the scheme, a www prefix, a
// trailing slash or a fragment. On GitHub a file is one page whether it was
// read raw or is cited by its blob URL, and so is a pull request under the
// issue URL that redirects to it.
func pageKey(raw string) string {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	host, path := strings.TrimPrefix(strings.ToLower(u.Host), "www."), strings.TrimSuffix(u.EscapedPath(), "/")
	if parts := strings.SplitN(path, "/", 4); host == "raw.githubusercontent.com" && len(parts) == 4 {
		host, path = "github.com", "/"+parts[1]+"/"+parts[2]+"/blob/"+strings.TrimPrefix(parts[3], "refs/heads/")
	}
	if host == "github.com" {
		path = githubIssue.ReplaceAllString(path, "$1/issues/$2")
	}
	key := host + path
	if u.RawQuery != "" {
		key += "?" + u.RawQuery
	}
	return key
}

var githubIssue = regexp.MustCompile(`^(/[^/]+/[^/]+)/pull/(\d+)$`)

// citedURL finds a URL in running text. It stops at the punctuation that
// closes a sentence or a bracket in Chinese and Japanese, which a report in
// those languages sets against a URL without a space.
var citedURL = regexp.MustCompile("https?://[^\\s<>\"'`\\]，。；、！？（）【】《》「」“”‘’]+")

// unread returns the URLs report cites whose pages are not in known, each
// once and in the order they appear.
func unread(report string, known map[string]bool) []string {
	var out []string
	seen := map[string]bool{}
	for _, cited := range citedURL.FindAllString(report, -1) {
		cited = trimCitation(cited)
		key := pageKey(cited)
		if known[key] || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, cited)
	}
	return out
}

// trimCitation drops what the text around a URL left on its end: sentence
// punctuation, markdown emphasis, and the bracket of a markdown link.
func trimCitation(u string) string {
	for {
		trimmed := strings.TrimRight(u, ".,;:!?*")
		if strings.HasSuffix(trimmed, ")") && strings.Count(trimmed, ")") > strings.Count(trimmed, "(") {
			trimmed = strings.TrimSuffix(trimmed, ")")
		}
		if trimmed == u {
			return u
		}
		u = trimmed
	}
}
