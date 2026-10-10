package fetch

import (
	"strings"
	"testing"
)

const copyPage = "# Title\n\nintro\n```sh\nmake build\n```\n中文段落\n"

func TestNumberLines(t *testing.T) {
	want := "1\t# Title\n\n3\tintro\n4\t```sh\n5\tmake build\n6\t```\n7\t中文段落\n"
	if got := numberLines(copyPage); got != want {
		t.Fatalf("numberLines = %q", got)
	}
}

func TestExpandCopies(t *testing.T) {
	cases := []struct {
		name, answer, want string
	}{
		{"range", "Run this:\n\n<copy lines=\"4-6\"/>\n\nDone.", "Run this:\n\n```sh\nmake build\n```\n\nDone."},
		{"single line", `<copy lines="7"/>`, "中文段落"},
		{"loose syntax", `<copy lines=3 - 3></copy>`, "intro"},
		{"end past the page", `<copy lines="7-90"/>`, "中文段落"},
		{"no tag", "plain answer", "plain answer"},
		{"inside a sentence", `It says <copy lines="3"/>. Then more.`, "It says \n\nintro\n\n. Then more."},
	}
	for _, c := range cases {
		got, warning := expandCopies(c.answer, copyPage, 0, 1000, false)
		if got != c.want || warning != "" {
			t.Errorf("%s: got %q, warning %q", c.name, got, warning)
		}
	}
}

func TestExpandCopiesInvalid(t *testing.T) {
	got, warning := expandCopies("a\n<copy lines=\"9-12\"/>\n<copy lines=\"6-4\"/>\nb", copyPage, 0, 1000, false)
	if got != "a\n\n\nb" || !strings.HasPrefix(warning, "2 passage(s)") {
		t.Fatalf("got %q, warning %q", got, warning)
	}
}

func TestExpandCopiesBudget(t *testing.T) {
	// Lines 1-3 weigh 8, 1 and 6 with their line breaks; the fourth does not fit.
	got, _ := expandCopies(`<copy lines="1-7"/> <copy lines="7"/>`, copyPage, 100, 15, false)
	// Line 4 starts 15 bytes into the text, which starts at 100 in the page.
	if !strings.HasPrefix(got, "# Title\n\nintro\n[Lines 4-7 ") || !strings.Contains(got, "offset=115.") {
		t.Fatalf("got %q", got)
	}
	if !strings.Contains(got, "[Lines 7-7 ") {
		t.Fatalf("a copy after the limit is not left out: %q", got)
	}
}

func TestExpandCopiesTruncated(t *testing.T) {
	for _, tail := range []string{"<", "<co", `<copy lines="4-`} {
		if got, _ := expandCopies("answer\n"+tail, copyPage, 0, 1000, true); got != "answer" {
			t.Errorf("tail %q: got %q", tail, got)
		}
	}
	if got, _ := expandCopies("a < b", copyPage, 0, 1000, false); got != "a < b" {
		t.Errorf("a complete answer lost its end: %q", got)
	}
}

func TestPageQuestion(t *testing.T) {
	page := Page{Title: "T", Content: "skipped\nfirst\nsecond\n"}
	got := pageQuestion(page, Args{URL: "https://example.com/a", Prompt: "what?"}, 8, len(page.Content), true)
	want := "<page url=\"https://example.com/a\" title=\"T\" excerpt=\"characters 8-21 of 21\">\n1\tfirst\n2\tsecond\n</page>\n\n" +
		copyReminder + "\n\n<request>\nwhat?\n</request>"
	if got != want {
		t.Fatalf("pageQuestion = %q", got)
	}
}
