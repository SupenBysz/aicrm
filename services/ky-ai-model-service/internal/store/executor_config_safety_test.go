package store

import "testing"

func TestNormalizeExecutorInputAlwaysForcesStdioTransport(t *testing.T) {
	for _, supplied := range []string{"", "stdio://", "ws://127.0.0.1:4500", "unix:///tmp/codex.sock"} {
		in := ExecutorConfigInput{AppServerListen: supplied}
		normalizeExecutorInputDefaults(&in)
		if in.AppServerListen != "stdio://" {
			t.Fatalf("input %q normalized to %q, want stdio://", supplied, in.AppServerListen)
		}
	}
}
