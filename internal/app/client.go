package app

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ClientAddr is the address a request came from. Behind a reverse proxy
// every connection comes from the proxy, so when the peer is on a loopback or
// private network the last X-Forwarded-For entry, the one the proxy itself
// added, is used; from a public peer the header would be the client's word.
func ClientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || !(peer.IsLoopback() || peer.IsPrivate()) {
		return host
	}
	forwarded := r.Header.Values("X-Forwarded-For")
	if len(forwarded) == 0 {
		return host
	}
	parts := strings.Split(forwarded[len(forwarded)-1], ",")
	if addr, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
		return addr.String()
	}
	return host
}
