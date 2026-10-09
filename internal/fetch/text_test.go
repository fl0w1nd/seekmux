package fetch

import (
	"strings"
	"testing"
)

func TestWeightedLen(t *testing.T) {
	if got := weightedLen("abc中文"); got != 7 {
		t.Fatalf("weightedLen = %d", got)
	}
}

func TestWeightedSliceEnd(t *testing.T) {
	if got := weightedSliceEnd("hello", 0, 100); got != 5 {
		t.Fatalf("a text within budget ends at its length, got %d", got)
	}
	// Three bytes per character, weight two each: a budget of 5 fits two.
	if got := weightedSliceEnd("中文字符", 0, 5); got != 6 {
		t.Fatalf("cut = %d", got)
	}
	text := "line one\nline two\nline three"
	if got := weightedSliceEnd(text, 0, 12); text[:got] != "line one\n" {
		t.Fatalf("the cut should move back to the line break, got %q", text[:got])
	}
	long := strings.Repeat("x", 5000)
	if got := weightedSliceEnd("a\n"+long, 0, 3000); got != 3000 {
		t.Fatalf("a distant line break must be ignored, got %d", got)
	}
	if got := weightedSliceEnd(text, 9, 1000); got != len(text) {
		t.Fatalf("slicing from an offset: %d", got)
	}
}

func TestAlignOffset(t *testing.T) {
	if got := alignOffset("中文", 1); got != 3 {
		t.Fatalf("alignOffset = %d", got)
	}
	if got := alignOffset("中文", 3); got != 3 {
		t.Fatalf("an aligned offset must not move, got %d", got)
	}
}

func TestURLClassification(t *testing.T) {
	if !isSourceCode("https://raw.githubusercontent.com/a/b/main/x.go?token=1") || isSourceCode("https://example.com/docs/page.html") {
		t.Fatal("source code detection is wrong")
	}
	if !hasExtension("https://example.com/Paper.PDF#page=2", ".pdf") {
		t.Fatal("pdf detection is wrong")
	}
}
