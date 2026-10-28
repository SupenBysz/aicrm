// Package startup handles bounded infrastructure initialization.
package startup

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// OpenDatabase retries transient startup failures and returns only a redacted
// final error. It never lets a configured but unavailable database silently turn
// into a permanently unready, otherwise live process.
func OpenDatabase[T any](parent context.Context, dsn string, open func(context.Context, string) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	var zero T
	var last error
	for {
		if err := ctx.Err(); err != nil {
			if parent.Err() != nil {
				return zero, parent.Err()
			}
			return zero, fmt.Errorf("database initialization timed out: %s", redact(last, dsn))
		}
		attempt, stop := context.WithTimeout(ctx, 3*time.Second)
		result, err := open(attempt, dsn)
		stop()
		if err == nil {
			return result, nil
		}
		last = err
		timer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func redact(err error, dsn string) string {
	if err == nil {
		return "unavailable"
	}
	message := err.Error()
	if dsn != "" {
		message = strings.ReplaceAll(message, dsn, "[database]")
	}
	if parsed, e := url.Parse(dsn); e == nil && parsed.User != nil {
		if password, ok := parsed.User.Password(); ok && password != "" {
			for _, secret := range []string{url.QueryEscape(password), url.PathEscape(password), password} {
				message = strings.ReplaceAll(message, secret, "[redacted]")
			}
		}
	}
	// Do not wrap the original error, which may retain an unredacted DSN.
	return message
}
