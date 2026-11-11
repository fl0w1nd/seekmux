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
	Default any `json:"default"`
	// Values are the choices of an enum, or the codes a provider accepts for
	// a country or language; none means any code.
	Values []string `json:"values,omitempty"`
	Min    int      `json:"min,omitempty"`
	Max    int      `json:"max,omitempty"`
	Format string   `json:"format,omitempty"`
}

// A route's country and language override the global ones of the search tool.
var (
	optCountry  = Option{Key: OptionCountry, Type: OptionString, Default: "", Format: FormatCountry}
	optLanguage = Option{Key: OptionLanguage, Type: OptionString, Default: "", Format: FormatLanguage}
)

// Brave takes only these countries, and these languages under its own names
// (search.braveLanguages); Tavily only the countries it has names for.
var (
	braveCountry = withValues(optCountry,
		"AR AT AU BE BR CA CH CL CN DE DK ES FI FR GB GR HK ID IN IT JP KR MX MY NL NO NZ PH PL PT RU SA SE TR TW US ZA")
	braveLanguage = withValues(optLanguage,
		"ar bg bn ca cs da de el en es et eu fi fr gl gu he hi hr hu is it ja kn ko lt lv ml mr ms nb nl no pa pl pt ro ru sk sl sr sv ta te th tr uk vi zh")
	tavilyCountry = withValues(optCountry, TavilyCountries)
)

// TavilyCountries are the countries Tavily has a name for.
const TavilyCountries = "AD AE AF AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CF CG CH CL CM CN CO CR CU CV CY CZ " +
	"DE DJ DK DO DZ EC EE EG ER ES ET FI FJ FR GA GB GE GH GM GN GQ GR GT HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP " +
	"KE KG KH KM KP KR KW KZ LB LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ " +
	"OM PA PE PG PH PK PL PT PY QA RO RS RU RW SA SD SE SG SI SK SN SO SS SV SY TD TG TH TJ TM TN TR TT TW TZ UA UG US UY UZ VE VN YE ZA ZM ZW"

func withValues(o Option, codes string) Option {
	o.Values = strings.Fields(codes)
	return o
}

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

// Accepts reports whether the provider takes s, a country or language code.
func (o Option) Accepts(s string) bool {
	return o.Format == "" || s == "" || len(o.Values) == 0 || slices.Contains(o.Values, s)
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
		if err := checkFormat(o.Format, s); err != nil {
			return err
		}
		if !o.Accepts(s) {
			return fmt.Errorf("%q is not supported by the provider", s)
		}
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
			s = cleanFormat(opt.Format, s)
			// A valid code the provider never took did nothing or failed
			// the call; the route falls back to the global one. A
			// malformed one is left for validation to report.
			if checkFormat(opt.Format, s) == nil && !opt.Accepts(s) {
				delete(r.Options, key)
				continue
			}
			value = s
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

// Routes returns the routes of a routed tool, and nil for any other.
func (c *Config) Routes(tool string) []Route {
	switch tool {
	case ToolSearch:
		return c.Search.Routes
	case ToolDevSearch:
		return c.DevSearch.Routes
	case ToolFetch:
		return c.Fetch.Routes
	}
	return nil
}

// TuneRoute replaces the parameters of provider's route for tool, in place:
// options holds what differs from the declared defaults, as a route does.
func (c *Config) TuneRoute(tool, provider string, options, extra map[string]any) error {
	routes := c.Routes(tool)
	i := slices.IndexFunc(routes, func(r Route) bool { return r.Provider == provider })
	if i < 0 {
		return fmt.Errorf("%s has no provider %q", tool, provider)
	}
	routes[i].Options, routes[i].ExtraBody = options, extra
	normalizeOptions(tool, &routes[i])
	if err := validateOptions(tool, routes[i]); err != nil {
		return fmt.Errorf("%s route %q: %w", tool, provider, err)
	}
	return nil
}

// PinRoute leaves provider as the only enabled route of tool, in place.
func (c *Config) PinRoute(tool, provider string) error {
	routes := c.Routes(tool)
	if !slices.ContainsFunc(routes, func(r Route) bool { return r.Provider == provider && r.Enabled }) {
		return fmt.Errorf("%s has no enabled provider %q", tool, provider)
	}
	for i := range routes {
		routes[i].Enabled = routes[i].Provider == provider
	}
	return nil
}
