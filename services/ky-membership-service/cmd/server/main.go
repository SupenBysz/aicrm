package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	cfg := config.Load("ky-membership-service", ":18083", "KY_MEMBERSHIP_SERVICE_HTTP_ADDR")
	app := server.New(cfg)
	if err := app.Run(ctx); err != nil {
		log.Fatalf("%s stopped with error: %v", cfg.ServiceName, err)
	}
}
