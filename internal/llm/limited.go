package llm

import (
	"context"

	"charm.land/fantasy"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

// Limited returns a copy of the model whose every request waits for the
// model's rate limit and holds one of its concurrency slots. It is for callers
// that hand the model to an agent, which decides on its own when to call it.
func (m *Model) Limited(limits *core.Limits) *Model {
	out := *m
	out.Language = &limitedModel{LanguageModel: m.Language, limits: limits, key: m.Key, rate: m.RateLimit, concurrency: m.Concurrency}
	return &out
}

type limitedModel struct {
	fantasy.LanguageModel
	limits      *core.Limits
	key         string
	rate        config.RateLimit
	concurrency int
}

func (l *limitedModel) acquire(ctx context.Context) (func(), error) {
	if err := l.limits.Rate.Acquire(ctx, l.key, l.rate); err != nil {
		return nil, err
	}
	return l.limits.Concurrency.Acquire(ctx, l.key, l.concurrency)
}

func (l *limitedModel) Generate(ctx context.Context, call fantasy.Call) (*fantasy.Response, error) {
	release, err := l.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return l.LanguageModel.Generate(ctx, call)
}

// Stream holds the concurrency slot until the stream has been read to its end.
func (l *limitedModel) Stream(ctx context.Context, call fantasy.Call) (fantasy.StreamResponse, error) {
	release, err := l.acquire(ctx)
	if err != nil {
		return nil, err
	}
	stream, err := l.LanguageModel.Stream(ctx, call)
	if err != nil {
		release()
		return nil, err
	}
	return func(yield func(fantasy.StreamPart) bool) {
		defer release()
		stream(yield)
	}, nil
}
