package startup

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDatabaseRetriesTransientFailure(t *testing.T) {
	calls := 0
	value, err := OpenDatabase(context.Background(), "postgresql://user:secret@database/db", func(context.Context, string) (int, error) {
		calls++
		if calls == 1 {
			return 0, errors.New("not ready")
		}
		return 42, nil
	})
	if err != nil || value != 42 || calls != 2 {
		t.Fatalf("value=%d calls=%d err=%v", value, calls, err)
	}
}
func TestDatabaseCancellation(t *testing.T) {
	c, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := OpenDatabase(c, "", func(context.Context, string) (int, error) { t.Fatal("unexpected connection"); return 0, nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestDatabaseErrorRedactsPassword(t *testing.T) {
	dsn := "postgresql://user:secret%40value@database/db"
	for _, message := range []string{dsn, "password secret@value", "password secret%40value"} {
		got := redact(errors.New(message), dsn)
		if strings.Contains(got, "secret") {
			t.Fatal("credential leaked")
		}
	}
}
