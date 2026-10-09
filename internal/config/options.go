package config

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

const (
	OptionBool   = "bool"
	OptionInt    = "int"
	OptionEnum   = "enum"
	OptionString = "string"

	// FormatCountry is an ISO 3166-1 alpha-2 code, FormatLanguage an ISO 639-1 code.
	FormatCountry  = "country"
	FormatLanguage = "language"

	OptionCountry  = "country"
	OptionLanguage = "language"
)

// Option declares one parameter of a provider for a tool. The console builds
// its control from the declaration, and a route stores only the values that
// differ from Default.
type Option struct {
	Key  string `json:"key"`
	Type string `json:"type"`
	// Default applies when the route does not set the option. A nil default
	// means the parameter is left out of the request.
	Default any      `json:"default"`
	Values  []string `json:"values,omitempty"`
	Min     int      `json:"min,omitempty"`
	Max     int      `json:"max,omitempty"`
	Format  string   `json:"format,omitempty"`
}

// A route's country and language override the global ones of the search tool.
var (
	optCountry  = Option{Key: OptionCountry, Type: OptionString, Default: "", Format: FormatCountry}
	optLanguage = Option{Key: OptionLanguage, Type: OptionString, Default: "", Format: FormatLanguage}
)

var (
	countryPattern  = regexp.MustCompile(`^[A-Z]{2}$`)
	languagePattern = regexp.MustCompile(`^[a-z]{2}$`)
)

func checkFormat(format, value string) error {
	switch {
	case value == "":
	case format == FormatCountry && !countryPattern.MatchString(value):
		return fmt.Errorf("%q is not a two-letter country code such as US", value)
	case format == FormatLanguage && !languagePattern.MatchString(value):
		return fmt.Errorf("%q is not a two-letter language code such as en", value)
	}
	return nil
}

func cleanFormat(format, value string) string {
	value = strings.TrimSpace(value)
	switch format {
	case FormatCountry:
		return strings.ToUpper(value)
	case FormatLanguage:
		return strings.ToLower(value)
	}
	return value
}

// asInt accepts what JSON decoding and Go code produce for a whole number.
func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	}
	return 0, false
}

// same reports whether a stored value is the option's default.
func (o Option) same(v any) bool {
	if o.Type == OptionInt {
		a, okA := asInt(v)
		b, okB := asInt(o.Default)
		return okA == okB && a == b
	}
	return v == o.Default
}

func (o Option) check(v any) error {
	switch o.Type {
	case OptionBool:
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("must be true or false")
		}
	case OptionInt:
		n, ok := asInt(v)
		if !ok {
			return fmt.Errorf("must be a whole number")
		}
		if n < o.Min || n > o.Max {
			return fmt.Errorf("must be between %d and %d", o.Min, o.Max)
		}
	case OptionEnum:
		if s, ok := v.(string); !ok || !slices.Contains(o.Values, s) {
			return fmt.Errorf("must be one of: %s", strings.Join(o.Values, ", "))
		}
	case OptionString:
		s, ok := v.(string)
		if !ok {
			return fmt.Errorf("must be text")
		}
		return checkFormat(o.Format, s)
	}
	return nil
}

// normalizeOptions drops what the provider does not declare for the tool and
// what merely repeats a default, so a later change of a default reaches every
// route that never chose otherwise.
func normalizeOptions(tool string, r *Route) {
	info, _ := Info(r.Provider)
	for key, value := range r.Options {
		i := slices.IndexFunc(info.Options[tool], func(o Option) bool { return o.Key == key })
		if i < 0 || value == nil {
			delete(r.Options, key)
			continue
		}
		opt := info.Options[tool][i]
		if s, ok := value.(string); ok && opt.Type == OptionString {
			value = cleanFormat(opt.Format, s)
			r.Options[key] = value
		}
		if opt.same(value) {
			delete(r.Options, key)
		}
	}
	if len(r.Options) == 0 {
		r.Options = nil
	}
	if len(r.ExtraBody) == 0 {
		r.ExtraBody = nil
	}
}

func validateOptions(tool string, r Route) error {
	info, _ := Info(r.Provider)
	for _, opt := range info.Options[tool] {
		if value, ok := r.Options[opt.Key]; ok {
			if err := opt.check(value); err != nil {
				return fmt.Errorf("option %q %w", opt.Key, err)
			}
		}
	}
	return nil
}

// Values are the options of a route with the defaults filled in.
type Values map[string]any

// OptionValues resolves the options of r for tool.
func OptionValues(tool string, r Route) Values {
	info, _ := Info(r.Provider)
	values := Values{}
	for _, opt := range info.Options[tool] {
		values[opt.Key] = opt.Default
		if v, ok := r.Options[opt.Key]; ok {
			values[opt.Key] = v
		}
	}
	return values
}

func (v Values) Str(key string) string {
	s, _ := v[key].(string)
	return s
}

func (v Values) Bool(key string) bool {
	b, _ := v[key].(bool)
	return b
}

// Int returns false when the option is unset.
func (v Values) Int(key string) (int, bool) { return asInt(v[key]) }
