package fetch

import (
	"strings"
	"unicode/utf8"
)

const lineBreakLookback = 2000

func runeWeight(r rune) int {
	if (r >= 0x4e00 && r <= 0x9fff) ||
		(r >= 0x3400 && r <= 0x4dbf) ||
		(r >= 0x3040 && r <= 0x30ff) ||
		(r >= 0xac00 && r <= 0xd7af) ||
		(r >= 0xf900 && r <= 0xfaff) {
		return 2
	}
	return 1
}

// weightedLen counts characters with CJK characters counting as 2, which
// approximates token density.
func weightedLen(text string) int {
	n := 0
	for _, r := range text {
		n += runeWeight(r)
	}
	return n
}

// weightedSliceEnd returns the end offset of the slice of text starting at
// start that fits in budget weighted characters. A cut is moved back to a
// nearby line break when there is one.
func weightedSliceEnd(text string, start, budget int) int {
	used := 0
	index := start
	for index < len(text) {
		r, size := utf8.DecodeRuneInString(text[index:])
		used += runeWeight(r)
		if used > budget {
			break
		}
		index += size
	}
	if index >= len(text) {
		return len(text)
	}
	if lineBreak := strings.LastIndexByte(text[:index], '\n'); lineBreak > start && index-lineBreak <= lineBreakLookback {
		return lineBreak + 1
	}
	return index
}

// alignOffset moves an offset that points into the middle of a character to
// the start of the next one.
func alignOffset(text string, offset int) int {
	for offset < len(text) && !utf8.RuneStart(text[offset]) {
		offset++
	}
	return offset
}
