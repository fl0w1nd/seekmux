package fetch

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// copyInstructions follows the system prompt, configured or default: it
// describes how the page is presented and how to quote it, which the answer
// is then parsed for.
const copyInstructions = `

Copying from the page:
The page is given with a line number and a tab in front of every line that has text. Blank lines carry no number but are counted. The numbers are not part of the page and mean nothing to the reader of your answer: never write or cite them ("line 12") outside a copy tag.

Never retype a passage of the page that is longer than three lines. Retyping is slow and is the usual reason an answer arrives late or cut off. Whenever the answer needs such a passage word for word (code, commands, configuration, a table, a long quote, a whole section), write a copy tag on a line of its own in its place:

<copy lines="120-164"/>

The tag is replaced by lines 120 to 164 exactly as they are on the page, markdown and code fences included. Let the range cover the opening and closing fence lines of a code block, and do not put the tag inside a fence of your own. A whole section is one tag, not one tag per paragraph. A tag is a paragraph of its own, never part of a sentence. Use as many tags as the answer needs, with your own words between them, and copy only what the request asks for. Type short quotes and single values yourself; an answer that needs no long passage has no tags.`

// copyReminder follows the page. The system prompt alone, a long page away,
// does not get passages copied; after the request the reminder does, but it
// makes the model deliberate over answers that need no copying.
const copyReminder = `Wherever the answer reproduces more than three lines of the page (code, a table, a quoted passage, a whole section), write <copy lines="first-last"/> there instead of retyping them. Do not mention line numbers anywhere else.`

var (
	copyTag = regexp.MustCompile(`<copy\s+lines\s*=\s*"?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*"?\s*/?>(?:\s*</copy>)?`)
	// cutCopyTag is a tag the end of a truncated answer cut in two.
	cutCopyTag = regexp.MustCompile(`<(?:c(?:o(?:p(?:y[^>]*)?)?)?)?$`)
)

// splitLines returns the lines the copy tags count.
func splitLines(text string) []string {
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}

// numberLines puts each line's number and a tab in front of it. Blank lines
// are counted but left bare, which keeps the numbering cheap on pages with
// short lines.
func numberLines(text string) string {
	lines := splitLines(text)
	var b strings.Builder
	b.Grow(len(text) + 6*len(lines))
	for i, line := range lines {
		if strings.TrimSpace(line) != "" {
			b.WriteString(strconv.Itoa(i + 1))
			b.WriteByte('\t')
			b.WriteString(line)
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// expandCopies replaces the copy tags in answer with the lines of text they
// name. base is the offset of text in the page. The copied text is held to
// budget weighted characters; what does not fit is left out with a note
// saying where to read it. warning reports tags that named no line.
func expandCopies(answer, text string, base, budget int, truncated bool) (expanded, warning string) {
	if truncated {
		answer = cutCopyTag.ReplaceAllString(answer, "")
	}
	lines := splitLines(text)
	invalid := 0
	lineOffset := func(first int) int {
		offset := base
		for _, line := range lines[:first-1] {
			offset += len(line) + 1
		}
		return offset
	}
	var out strings.Builder
	rest := 0
	for _, m := range copyTag.FindAllStringSubmatchIndex(answer, -1) {
		first, _ := strconv.Atoi(answer[m[2]:m[3]])
		last := first
		if m[4] >= 0 {
			last, _ = strconv.Atoi(answer[m[4]:m[5]])
		}
		last = min(last, len(lines))
		out.WriteString(answer[rest:m[0]])
		rest = m[1]
		if first < 1 || first > last {
			invalid++
			continue
		}
		// A tag written inside a sentence still copies whole lines, which
		// must not run into the words around it.
		if before := strings.TrimRight(answer[:m[0]], " \t"); before != "" && !strings.HasSuffix(before, "\n") {
			out.WriteString("\n\n")
		}
		for n := first; n <= last; n++ {
			cost := weightedLen(lines[n-1]) + 1
			if cost > budget {
				budget = 0
				fmt.Fprintf(&out, "[Lines %d-%d of this passage are left out: the answer is at its length limit. Read them with raw=true and offset=%d.]", n, last, lineOffset(n))
				break
			}
			budget -= cost
			out.WriteString(lines[n-1])
			if n < last {
				out.WriteByte('\n')
			}
		}
		if after := strings.TrimLeft(answer[rest:], " \t"); after != "" && !strings.HasPrefix(after, "\n") {
			out.WriteString("\n\n")
		}
	}
	out.WriteString(answer[rest:])
	expanded = out.String()
	if invalid > 0 {
		warning = fmt.Sprintf("%d passage(s) the helper model meant to copy from the page could not be located and are missing from the answer.", invalid)
	}
	return strings.TrimSpace(expanded), warning
}
