package appserver

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeProcess struct {
	inputReader  *io.PipeReader
	inputWriter  *io.PipeWriter
	outputReader *io.PipeReader
	outputWriter *io.PipeWriter
	killOnce     sync.Once
}

func newFakeProcess() *fakeProcess {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	return &fakeProcess{inputReader: inR, inputWriter: inW, outputReader: outR, outputWriter: outW}
}

func (p *fakeProcess) Stdin() io.WriteCloser { return p.inputWriter }
func (p *fakeProcess) Stdout() io.ReadCloser { return p.outputReader }
func (p *fakeProcess) Wait() error           { return nil }
func (p *fakeProcess) Kill() error {
	p.killOnce.Do(func() {
		_ = p.inputWriter.Close()
		_ = p.outputWriter.Close()
	})
	return nil
}

func TestDeviceCodeLoginAccountAndCatalogUseStructuredProtocol(t *testing.T) {
	process := newFakeProcess()
	client := NewClient(process)
	defer client.Close()
	requests := make(chan map[string]any, 16)
	go fakeServer(t, process, requests)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := client.Initialize(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	challenge, err := client.StartDeviceCodeLogin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if challenge.LoginID != "login-safe-id" || challenge.VerificationURL != "https://auth.openai.com/device" || challenge.UserCode != "ABCD-EFGH" {
		t.Fatalf("unexpected challenge: %#v", challenge)
	}
	completion, err := client.WaitLoginCompleted(ctx, challenge.LoginID)
	if err != nil || !completion.Success {
		t.Fatalf("completion=%#v err=%v", completion, err)
	}
	account, err := client.ReadAccount(ctx, true)
	if err != nil || account.Account == nil || account.Account.PlanType != "plus" {
		t.Fatalf("account=%#v err=%v", account, err)
	}
	models, err := client.ListModels(ctx)
	if err != nil || len(models) != 1 || models[0].ModelKey != "gpt-5.6" || models[0].CatalogItemID != "catalog-id-not-model-key" {
		t.Fatalf("models=%#v err=%v", models, err)
	}

	methods := make([]string, 0, 8)
	for len(requests) > 0 {
		request := <-requests
		methods = append(methods, request["method"].(string))
	}
	joined := strings.Join(methods, ",")
	for _, required := range []string{MethodInitialize, MethodInitialized, MethodAccountLoginStart, MethodAccountRead, MethodModelList} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing method %s in %s", required, joined)
		}
	}
}

func fakeServer(t *testing.T, process *fakeProcess, requests chan<- map[string]any) {
	decoder := json.NewDecoder(process.inputReader)
	for {
		var request map[string]any
		if err := decoder.Decode(&request); err != nil {
			return
		}
		requests <- request
		method, _ := request["method"].(string)
		id, hasID := request["id"]
		if !hasID {
			continue
		}
		var result any = map[string]any{}
		switch method {
		case MethodInitialize:
			result = map[string]any{"codexHome": "/must-not-escape", "platformFamily": "unix", "platformOs": "linux", "userAgent": "codex-test"}
		case MethodAccountLoginStart:
			result = map[string]any{"type": "chatgptDeviceCode", "loginId": "login-safe-id", "verificationUrl": "https://auth.openai.com/device", "userCode": "ABCD-EFGH"}
		case MethodAccountRead:
			result = map[string]any{"requiresOpenaiAuth": true, "account": map[string]any{"type": "chatgpt", "email": "person@example.com", "planType": "plus"}}
		case MethodModelList:
			result = map[string]any{"data": []any{map[string]any{
				"id": "catalog-id-not-model-key", "model": "gpt-5.6", "displayName": "GPT-5.6", "description": "test",
				"hidden": false, "isDefault": true, "inputModalities": []string{"text", "image"},
				"defaultReasoningEffort": "high", "supportedReasoningEfforts": []any{}, "upgrade": nil,
			}}, "nextCursor": nil}
		}
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		_, _ = process.outputWriter.Write(append(response, '\n'))
		if method == MethodAccountLoginStart {
			notification, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "method": MethodLoginCompleted,
				"params": map[string]any{"loginId": "login-safe-id", "success": true, "error": nil},
			})
			_, _ = process.outputWriter.Write(append(notification, '\n'))
		}
	}
}
