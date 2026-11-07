package worker

import "testing"

// Route follows OpenCLI's choice of profile, decided from the reported list.
func TestStateRoutesProfilesTheWayOpenCLIDoes(t *testing.T) {
	open := func(id string) Profile { return Profile{ID: id, Connected: true} }
	closed := Profile{ID: "closed"}
	def := Profile{ID: "def", Default: true, Connected: true}
	for _, tc := range []struct {
		name     string
		profiles []Profile
		chosen   string
		want     string
	}{
		{"chosen and open", []Profile{open("a"), open("b")}, "a", ""},
		{"chosen and unknown", []Profile{open("a")}, "gone", CodeProfileMissing},
		{"chosen and closed", []Profile{open("a"), closed}, "closed", CodeBrowserUnavailable},
		{"none chosen, one open", []Profile{open("a"), closed}, "", ""},
		{"none chosen, several open", []Profile{open("a"), open("b")}, "", CodeProfileMissing},
		{"none chosen, several open, one default", []Profile{open("a"), def}, "", ""},
		{"none chosen, none open", []Profile{closed}, "", CodeBrowserUnavailable},
	} {
		state := State{Ready: true, Profiles: tc.profiles}
		got := ""
		if err := state.Route(tc.chosen); err != nil {
			got = err.Code
		}
		if got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
