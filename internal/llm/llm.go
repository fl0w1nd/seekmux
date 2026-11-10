// Package llm is the only place that touches the fantasy agent runtime. It
// turns configured LLM providers into models and runs single chat turns; the
// research agent builds on the same models.
package llm

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"
	"charm.land/fantasy/providers/anthropic"
	"charm.land/fantasy/providers/openai"
	"charm.land/fantasy/providers/openaicompat"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

// Model is a configured model, ready to use.
type Model struct {
	Attrs map[string]any
	// Label is the model's id, used in traces and errors.
	Label           string
	Language        fantasy.LanguageModel
	Options         fantasy.ProviderOptions
	MaxOutputTokens *int64
	// Key, RateLimit and Concurrency are the model's limits; see LimitKey.
	Key         string
	RateLimit   config.RateLimit
	Concurrency int
	// promptCache is set for APIs that only cache a prompt when asked to.
	promptCache bool
}

// anthropicMaxOutput is sent to Anthropic-format models that set no limit of
// their own: that API requires one, and the runtime's fallback of 4096 would
// cut a research report short.
const anthropicMaxOutput int64 = 32000

// LimitKey identifies a model's rate and concurrency limits.
func LimitKey(id string) string { return "llm:" + id }

// NewModel builds the model with the given id from cfg.
func NewModel(ctx context.Context, cfg *config.Config, id string, client *http.Client) (*Model, error) {
	if id == "" {
		return nil, errors.New("no model is configured")
	}
	p, ref, ok := cfg.ModelByID(id)
	if !ok {
		return nil, fmt.Errorf("model %q does not exist", id)
	}
	limit, err := config.ParseRateLimit(ref.RateLimit)
	if err != nil {
		return nil, fmt.Errorf("model %q: %w", id, err)
	}

	var provider fantasy.Provider
	var options fantasy.ProviderOptions
	maxOutput := ref.MaxOutputTokens
	switch p.Type {
	case config.LLMAnthropic:
		opts := []anthropic.Option{anthropic.WithAPIKey(p.APIKey), anthropic.WithHTTPClient(client)}
		if p.BaseURL != "" {
			// The SDK appends /v1/messages itself.
			opts = append(opts, anthropic.WithBaseURL(strings.TrimSuffix(p.BaseURL, "/v1")))
		}
		if len(p.Headers) > 0 {
			opts = append(opts, anthropic.WithHeaders(p.Headers))
		}
		provider, err = anthropic.New(opts...)
		options = anthropicOptions(ref)
		if maxOutput <= 0 {
			maxOutput = anthropicMaxOutput
		}
	default:
		opts := []openaicompat.Option{
			openaicompat.WithAPIKey(p.APIKey),
			openaicompat.WithBaseURL(p.BaseURL),
			openaicompat.WithHTTPClient(client),
		}
		if len(p.Headers) > 0 {
			opts = append(opts, openaicompat.WithHeaders(p.Headers))
		}
		provider, err = openaicompat.New(opts...)
		options = openAIOptions(ref)
	}
	if err != nil {
		return nil, fmt.Errorf("llm provider %q: %w", p.ID, err)
	}

	language, err := provider.LanguageModel(ctx, ref.Name)
	if err != nil {
		return nil, fmt.Errorf("model %q: %w", id, err)
	}
	m := &Model{
		Attrs: map[string]any{"provider": p.ID, "model": ref.Name, "api": p.Type},
		Label: id, Language: language, Options: options,
		Key: LimitKey(id), RateLimit: limit, Concurrency: ref.Concurrency,
		promptCache: p.Type == config.LLMAnthropic,
	}
	reasoning := map[string]any{}
	if ref.Reasoning.Mode != "" {
		reasoning["mode"] = ref.Reasoning.Mode
	}
	if ref.Reasoning.Effort != "" {
		reasoning["effort"] = ref.Reasoning.Effort
	}
	if ref.Reasoning.BudgetTokens > 0 {
		reasoning["budget_tokens"] = ref.Reasoning.BudgetTokens
	}
	if len(reasoning) > 0 {
		m.Attrs["reasoning"] = reasoning
	}
	if len(ref.ExtraBody) > 0 {
		m.Attrs["extra_body"] = ref.ExtraBody
	}
	m.Attrs["max_output_tokens"] = maxOutput
	if maxOutput > 0 {
		m.MaxOutputTokens = &maxOutput
	}
	return m, nil
}

// Usage converts the runtime's usage, which counts cached input apart from
// the rest, into the gateway's.
func Usage(u fantasy.Usage) core.Usage {
	return core.Usage{
		InputTokens:      u.InputTokens + u.CacheReadTokens + u.CacheCreationTokens,
		OutputTokens:     u.OutputTokens,
		CacheReadTokens:  u.CacheReadTokens,
		CacheWriteTokens: u.CacheCreationTokens,
	}
}

// CachePrefix marks the end of messages as a prompt cache breakpoint, so the
// next step of an agent loop reads everything before it from the cache. It
// returns nil for models whose API caches prompts by itself.
func (m *Model) CachePrefix(messages []fantasy.Message) []fantasy.Message {
	if !m.promptCache || len(messages) == 0 {
		return nil
	}
	marked := append([]fantasy.Message(nil), messages...)
	marked[len(marked)-1].ProviderOptions = anthropic.NewProviderCacheControlOptions(&anthropic.ProviderCacheControlOptions{
		CacheControl: anthropic.CacheControl{Type: "ephemeral"},
	})
	return marked
}

// outputLimit is the tighter of the model's output limit and the caller's.
func (m *Model) outputLimit(limit int64) *int64 {
	if limit <= 0 || (m.MaxOutputTokens != nil && *m.MaxOutputTokens < limit) {
		return m.MaxOutputTokens
	}
	return &limit
}

func anthropicOptions(m config.Model) fantasy.ProviderOptions {
	opts := &anthropic.ProviderOptions{ExtraBody: map[string]any{}}
	switch m.Reasoning.Mode {
	case config.ReasoningOff:
		opts.ExtraBody["thinking"] = map[string]any{"type": "disabled"}
	case config.ReasoningEffort:
		effort := anthropic.Effort(m.Reasoning.Effort)
		opts.Effort = &effort
	case config.ReasoningBudget:
		opts.Thinking = &anthropic.ThinkingProviderOption{BudgetTokens: m.Reasoning.BudgetTokens}
	}
	maps.Copy(opts.ExtraBody, m.ExtraBody)
	return anthropic.NewProviderOptions(opts)
}

func openAIOptions(m config.Model) fantasy.ProviderOptions {
	opts := &openaicompat.ProviderOptions{ExtraBody: m.ExtraBody}
	switch m.Reasoning.Mode {
	case config.ReasoningOff:
		effort := openai.ReasoningEffortNone
		opts.ReasoningEffort = &effort
	case config.ReasoningEffort:
		effort := openai.ReasoningEffort(m.Reasoning.Effort)
		opts.ReasoningEffort = &effort
	}
	return openaicompat.NewProviderOptions(opts)
}

// ChatResult is the answer of a single chat turn.
type ChatResult struct {
	Model string
	Text  string
	// Truncated is set when the timeout or the output token limit cut the
	// answer off; Text is the part received.
	Truncated bool
}

type ChatOptions struct {
	// FirstChunkTimeout bounds the wait for the stream to start; a stream that
	// does not start is retried up to MaxRetries times in total.
	FirstChunkTimeout time.Duration
	// TotalTimeout bounds a started stream. What arrived by then is returned
	// as a truncated answer.
	TotalTimeout time.Duration
	MaxRetries   int
	// MaxOutputTokens tightens the model's own output limit; 0 leaves it.
	MaxOutputTokens int64
}

// Chat runs one streamed turn without tools.
func (m *Model) Chat(ctx context.Context, system, user string, opt ChatOptions) (ChatResult, error) {
	trace := core.TraceFrom(ctx)
	agent := fantasy.NewAgent(m.Language, fantasy.WithSystemPrompt(system))
	noRetries := 0

	for attempt := 0; attempt < max(opt.MaxRetries, 1); attempt++ {
		attrs := maps.Clone(m.Attrs)
		if attrs == nil {
			attrs = map[string]any{}
		}
		if limit := m.outputLimit(opt.MaxOutputTokens); limit != nil {
			attrs["max_output_tokens"] = *limit
		}
		attrs["first_chunk_timeout_ms"], attrs["total_timeout_ms"] = opt.FirstChunkTimeout.Milliseconds(), opt.TotalTimeout.Milliseconds()
		attrs["try"], attrs["max_tries"], attrs["role"] = attempt+1, max(opt.MaxRetries, 1), "extract"
		spanCtx, span := core.StartSpan(ctx, "llm", m.Label, attrs)
		began := time.Now()
		var firstChunk int64
		var used core.Usage
		var finish string
		runCtx, cancel := context.WithCancel(spanCtx)
		var mu sync.Mutex
		var text strings.Builder
		started := false
		timer := time.AfterFunc(opt.FirstChunkTimeout, cancel)

		record := trace.Begin("llm", m.Label, "")
		closeSpan := func(err error) {
			span.Set(map[string]any{"usage": core.UsageAttrs(used), "first_chunk_ms": firstChunk, "truncated": false, "finish_reason": finish})
			span.End(err)
		}
		done := func(err error) { record(err); closeSpan(err) }
		result, err := agent.Stream(runCtx, fantasy.AgentStreamCall{
			Prompt:          user,
			ProviderOptions: m.Options,
			MaxOutputTokens: m.outputLimit(opt.MaxOutputTokens),
			MaxRetries:      &noRetries,
			// Any part, reasoning included, shows the stream is alive.
			OnChunk: func(fantasy.StreamPart) error {
				mu.Lock()
				defer mu.Unlock()
				if !started {
					started = true
					firstChunk = time.Since(began).Milliseconds()
					timer.Stop()
					timer = time.AfterFunc(opt.TotalTimeout, cancel)
				}
				return nil
			},
			OnStreamFinish: func(u fantasy.Usage, reason fantasy.FinishReason, _ fantasy.ProviderMetadata) error {
				used = Usage(u)
				finish = string(reason)
				return nil
			},
			OnTextDelta: func(_, delta string) error {
				span.Text(delta)
				mu.Lock()
				text.WriteString(delta)
				mu.Unlock()
				return nil
			},
		})
		mu.Lock()
		timer.Stop()
		answer := strings.TrimSpace(text.String())
		wasStarted := started
		mu.Unlock()
		timedOut := runCtx.Err() != nil && ctx.Err() == nil
		cancel()

		if err == nil {
			used = Usage(result.TotalUsage)
			finish = string(result.Response.FinishReason)
			record(nil)
			trace.AddUsage(m.Label, used)
			hitLimit := result.Response.FinishReason == fantasy.FinishReasonLength
			var responseErr error
			if answer == "" {
				responseErr = errors.New("the model returned an empty response")
				if hitLimit {
					responseErr = errors.New("the model used its whole output token limit before answering")
				}
			}
			closeSpan(responseErr)
			span.Set(map[string]any{"truncated": hitLimit})
			if responseErr != nil {
				return ChatResult{}, responseErr
			}
			return ChatResult{Model: m.Label, Text: answer, Truncated: hitLimit}, nil
		}
		if !timedOut {
			err = Describe(err)
			done(err)
			return ChatResult{}, err
		}
		if !wasStarted {
			done(fmt.Errorf("stream did not start within %s: %w", opt.FirstChunkTimeout, core.ErrUnresponsive))
			continue
		}
		if answer == "" {
			err := fmt.Errorf("the model produced no content within %s: %w", opt.TotalTimeout, core.ErrUnresponsive)
			done(err)
			return ChatResult{}, err
		}
		done(nil)
		span.Set(map[string]any{"truncated": true})
		return ChatResult{Model: m.Label, Text: answer, Truncated: true}, nil
	}
	return ChatResult{}, fmt.Errorf("the stream did not start in %d attempts: %w", max(opt.MaxRetries, 1), core.ErrUnresponsive)
}

// Describe turns a fantasy error into a short one that carries the HTTP
// status instead of dumping the request.
func Describe(err error) error {
	var providerErr *fantasy.ProviderError
	if errors.As(err, &providerErr) && providerErr.StatusCode != 0 {
		message := providerErr.Message
		if message == "" {
			message = providerErr.Title
		}
		return &core.HTTPError{Provider: "model", StatusCode: providerErr.StatusCode, Body: message}
	}
	return err
}
