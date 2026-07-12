//go:build linux

package appserver_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
)

func TestInstalledBrokerLaunchesRealCodexOverStdioOnly(t *testing.T) {
	if os.Getenv("KY_TEST_INSTALLED_RUNTIME_BROKER") != "1" {
		t.Skip("set KY_TEST_INSTALLED_RUNTIME_BROKER=1 for system integration")
	}
	root := os.Getenv("KY_AGENT_EXECUTOR_CREDENTIAL_ROOT")
	if root == "" {
		root = "/var/lib/aicrm-agent-executors"
	}
	manager, err := credentialfs.New(root)
	if err != nil {
		t.Fatal("credential manager unavailable")
	}
	suffix := time.Now().UTC().Format("20060102T150405.000000000")
	operationID := "probe_" + strings.NewReplacer(".", "_", ":", "_").Replace(suffix)
	staging, err := manager.CreateStaging("broker_probe", operationID)
	if err != nil {
		t.Fatal("staging create failed")
	}
	cleaned := false
	defer func() {
		if !cleaned {
			_ = manager.RemoveEphemeral(staging)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	process, err := (appserver.BrokerLauncher{SocketPath: "/run/aicrm-agent-runtime.sock"}).Launch(ctx, operationID, staging)
	if err != nil {
		t.Fatalf("broker launch failed: %v", err)
	}
	client := appserver.NewClient(process)
	closed := false
	defer func() {
		if !closed {
			_ = client.Close()
		}
	}()
	if err := client.Initialize(ctx, "broker-probe"); err != nil {
		t.Fatal("App Server initialize failed")
	}
	if _, err := client.ReadAccount(ctx, false); err != nil {
		t.Fatal("structured account/read failed")
	}
	models, err := client.ListModels(ctx)
	if err != nil || len(models) == 0 {
		t.Fatal("structured model/list failed")
	}
	unit := "aicrm-codex-" + operationID + ".service"
	output, err := exec.Command("/usr/bin/systemctl", "show", unit, "--property=DynamicUser", "--property=NoNewPrivileges", "--property=PrivateDevices", "--property=ProtectSystem", "--property=StateDirectory", "--property=MainPID", "--value").CombinedOutput()
	if err != nil {
		t.Fatal("transient unit inspection failed")
	}
	text := string(output)
	for _, required := range []string{"yes", "strict", "aicrm-codex-runtime/" + operationID} {
		if !strings.Contains(text, required) {
			t.Fatalf("transient unit missing %s", required)
		}
	}
	pidText, err := exec.Command("/usr/bin/systemctl", "show", unit, "--property=MainPID", "--value").Output()
	if err != nil {
		t.Fatal("transient runtime pid unavailable")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidText)))
	if err != nil || pid < 2 {
		t.Fatal("transient runtime pid is invalid")
	}
	processInfo, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	if err != nil {
		t.Fatal("transient runtime process disappeared")
	}
	processStat, ok := processInfo.Sys().(*syscall.Stat_t)
	if !ok || processStat.Uid == 0 || processStat.Uid == uint32(os.Geteuid()) {
		t.Fatal("Codex runtime did not receive an isolated non-root UID")
	}
	if _, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ")); err == nil {
		t.Fatal("control-plane UID can read Codex runtime environment")
	}
	if _, err := os.ReadDir(filepath.Join("/proc", strconv.Itoa(pid), "fd")); err == nil {
		t.Fatal("control-plane UID can inspect Codex runtime pipe handles")
	}
	if err := client.Close(); err != nil {
		t.Fatalf("runtime finalization failed: %v", err)
	}
	closed = true
	if _, err := credentialfs.DigestTree(staging); err != nil {
		t.Fatal("credential home was not restored safely")
	}
	if entries, err := os.ReadDir(staging); err != nil || len(entries) == 0 {
		t.Fatal("App Server runtime state was not harvested back to staging")
	}
	if entries, err := os.ReadDir(filepath.Join(root, "broker_probe", "revisions")); err == nil && len(entries) > 0 {
		t.Fatal("probe unexpectedly promoted credentials")
	}
	if err := manager.RemoveEphemeral(staging); err != nil {
		t.Fatalf("credential probe cleanup failed: %v", err)
	}
	cleaned = true
}

func TestInstalledBrokerRecoversCredentialHomeAfterBrokerRestart(t *testing.T) {
	readyPath := os.Getenv("KY_TEST_BROKER_CRASH_READY")
	continuePath := os.Getenv("KY_TEST_BROKER_CRASH_CONTINUE")
	if os.Getenv("KY_TEST_INSTALLED_RUNTIME_BROKER") != "1" || readyPath == "" || continuePath == "" {
		t.Skip("set installed broker crash-recovery test markers")
	}
	root := os.Getenv("KY_AGENT_EXECUTOR_CREDENTIAL_ROOT")
	if root == "" {
		root = "/var/lib/aicrm-agent-executors"
	}
	manager, err := credentialfs.New(root)
	if err != nil {
		t.Fatal("credential manager unavailable")
	}
	suffix := time.Now().UTC().Format("20060102T150405.000000000")
	operationID := "crash_" + strings.NewReplacer(".", "_", ":", "_").Replace(suffix)
	staging, err := manager.CreateStaging("broker_crash_probe", operationID)
	if err != nil {
		t.Fatal("staging create failed")
	}
	cleaned := false
	defer func() {
		if !cleaned {
			_ = manager.RemoveEphemeral(staging)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	process, err := (appserver.BrokerLauncher{SocketPath: "/run/aicrm-agent-runtime.sock"}).Launch(ctx, operationID, staging)
	if err != nil {
		t.Fatalf("broker launch failed: %v", err)
	}
	client := appserver.NewClient(process)
	if err := client.Initialize(ctx, "broker-crash-probe"); err != nil {
		t.Fatal("App Server initialize failed")
	}
	if err := os.WriteFile(readyPath, []byte("ready"), 0o600); err != nil {
		t.Fatal("crash marker create failed")
	}
	for {
		if _, err := os.Stat(continuePath); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("broker restart was not triggered")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if err := client.Close(); err == nil {
		t.Fatal("broker crash did not close the control channel")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := credentialfs.DigestTree(staging); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("broker restart did not restore the credential home")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := manager.RemoveEphemeral(staging); err != nil {
		t.Fatalf("recovered credential home cleanup failed: %v", err)
	}
	cleaned = true
}
