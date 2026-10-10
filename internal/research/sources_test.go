package research

import (
	"slices"
	"testing"
)

func TestUnreadListsTheCitationsTheAgentNeverOpened(t *testing.T) {
	known := map[string]bool{}
	for _, read := range []string{
		"https://go.dev/doc/effective_go",
		"http://www.example.com/a/",
		"https://en.wikipedia.org/wiki/Go_(programming_language)",
		"https://example.org/search?q=1",
		"https://github.com/golang/go/issues/123",
		"https://raw.githubusercontent.com/golang/go/master/README.md",
		"https://raw.githubusercontent.com/golang/go/refs/heads/master/doc/go_spec.html",
	} {
		known[pageKey(read)] = true
	}
	report := `Go formats code with gofmt (https://go.dev/doc/effective_go#formatting).
See [the article](https://en.wikipedia.org/wiki/Go_(programming_language)) and **https://example.com/a**.
另见 https://example.org/search?q=1。未打开的有 https://unread.example/x，以及（https://unread.example/y）。
Files read raw: https://github.com/golang/go/blob/master/README.md, https://github.com/golang/go/blob/master/doc/go_spec.html.
A pull request read under its issue URL: https://github.com/golang/go/pull/123.
Repeated: https://unread.example/x/, and a different query https://example.org/search?q=2.`

	got := unread(report, known)
	want := []string{"https://unread.example/x", "https://unread.example/y", "https://example.org/search?q=2"}
	if !slices.Equal(got, want) {
		t.Errorf("unread = %q, want %q", got, want)
	}
}
