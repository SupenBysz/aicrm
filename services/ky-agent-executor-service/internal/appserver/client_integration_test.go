package appserver

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type commandProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

func (p *commandProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *commandProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *commandProcess) Wait() error           { return p.cmd.Wait() }
func (p *commandProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

func TestRealCodexAppServerStructuredHandshake(t *testing.T) {
	if os.Getenv("KY_TEST_CODEX_APP_SERVER") != "1" {
		t.Skip("set KY_TEST_CODEX_APP_SERVER=1 for target Codex protocol verification")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	codexHome := filepath.Join(t.TempDir(), "codex-home")
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "codex", "app-server", "--listen", "stdio://")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent", "CODEX_HOME=" + codexHome}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	client := NewClient(&commandProcess{cmd: cmd, stdin: stdin, stdout: stdout})
	defer client.Close()
	if err := client.Initialize(ctx, "integration-test"); err != nil {
		t.Fatal(err)
	}
	account, err := client.ReadAccount(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if account.Account != nil || !account.RequiresOpenAIAuth {
		t.Fatalf("empty isolated home unexpectedly authorized: %#v", account)
	}
	models, err := client.ListModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) == 0 {
		t.Fatal("target App Server returned an empty model catalog")
	}
}
