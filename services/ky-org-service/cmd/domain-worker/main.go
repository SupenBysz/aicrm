package main

import (
	"context"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/domains"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	base, token := os.Getenv("KY_DOMAIN_ORG_URL"), os.Getenv("KY_DOMAIN_WORKER_TOKEN")
	if base == "" || len(token) < 32 {
		log.Fatal("domain worker configuration missing")
	}
	raw, e := os.ReadFile(os.Getenv("KY_DOMAIN_CF_TOKEN_FILE"))
	if e != nil {
		log.Fatal("domain worker credential unavailable")
	}
	p := domains.Provider{InstanceID: os.Getenv("KY_DOMAIN_INSTANCE_ID"), AllowZoneCreate: os.Getenv("KY_DOMAIN_ALLOW_ZONE_CREATE") == "1", Token: strings.TrimSpace(string(raw)), AccountID: os.Getenv("KY_DOMAIN_CF_ACCOUNT_ID"), TunnelID: os.Getenv("KY_DOMAIN_CF_TUNNEL_ID"), Origin: os.Getenv("KY_DOMAIN_TUNNEL_ORIGIN"), ProbeSecret: os.Getenv("KY_DOMAIN_PROBE_SECRET")}
	if address := os.Getenv("KY_DOMAIN_DNS_RESOLVER"); address != "" {
		host, port, err := net.SplitHostPort(address)
		ip := net.ParseIP(host)
		if err != nil || port != "53" || ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
			log.Fatal("domain DNS resolver must be a public IP on port 53")
		}
		p.Resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, network, address)
		}}
	}
	timer := time.NewTicker(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			func() {
				taskCtx, cancel := context.WithTimeout(ctx, 65*time.Second)
				defer cancel()
				var work domains.Work
				if domainentry.Call(taskCtx, base, token, "/internal/v1/domains/worker/claim", map[string]any{}, &work) != nil {
					return
				}
				work.Binding.ProviderID = work.ProviderID
				obs := domains.Observation{Paused: true, Message: "平台自动接入配置尚未就绪，任务将保留并自动重试"}
				if work.Ready || (work.Binding.State == "detaching" || work.Binding.State == "detached") {
					obs = p.Observe(taskCtx, work.Binding)
				}
				var result map[string]any
				// Complete with a fresh bounded context if the provider deadline exhausted.
				saveCtx, end := context.WithTimeout(ctx, 5*time.Second)
				defer end()
				if domainentry.Call(saveCtx, base, token, "/internal/v1/domains/worker/complete", map[string]any{"work": work, "observation": obs}, &result) != nil {
					log.Print("domain task result pending reconciliation")
				}
			}()
		}
	}
}
