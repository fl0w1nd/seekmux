package core

import (
	"container/list"
	"sync"
	"time"
)

// Cache is an in-memory TTL cache bounded by the total size of its values,
// evicting the oldest entries first.
type Cache[V any] struct {
	mu       sync.Mutex
	maxBytes int
	size     func(V) int
	bytes    int
	order    *list.List
	items    map[string]*list.Element
}

type cacheEntry[V any] struct {
	key       string
	value     V
	bytes     int
	expiresAt time.Time
}

func NewCache[V any](maxBytes int, size func(V) int) *Cache[V] {
	return &Cache[V]{maxBytes: maxBytes, size: size, order: list.New(), items: map[string]*list.Element{}}
}

func (c *Cache[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var zero V
	el, ok := c.items[key]
	if !ok {
		return zero, false
	}
	entry := el.Value.(*cacheEntry[V])
	if time.Now().After(entry.expiresAt) {
		c.remove(el)
		return zero, false
	}
	return entry.value, true
}

func (c *Cache[V]) Set(key string, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.remove(el)
	}
	entry := &cacheEntry[V]{key: key, value: value, bytes: c.size(value) + len(key), expiresAt: time.Now().Add(ttl)}
	if entry.bytes > c.maxBytes {
		return
	}
	c.items[key] = c.order.PushBack(entry)
	c.bytes += entry.bytes

	now := time.Now()
	for el := c.order.Front(); el != nil; {
		next := el.Next()
		if e := el.Value.(*cacheEntry[V]); c.bytes > c.maxBytes || now.After(e.expiresAt) {
			c.remove(el)
		}
		el = next
	}
}

func (c *Cache[V]) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.order.Init()
	c.items = map[string]*list.Element{}
	c.bytes = 0
}

// Stats returns the number of entries and their total size.
func (c *Cache[V]) Stats() (entries, bytes int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items), c.bytes
}

func (c *Cache[V]) remove(el *list.Element) {
	entry := el.Value.(*cacheEntry[V])
	c.order.Remove(el)
	delete(c.items, entry.key)
	c.bytes -= entry.bytes
}
