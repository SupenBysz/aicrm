package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	cfg := config.Load("ky-auth-service", ":18081", "KY_AUTH_SERVICE_HTTP_ADDR")
	app := server.New(cfg)
	if err := app.Run(ctx); err != nil {
		log.Fatalf("%s stopped with error: %v", cfg.ServiceName, err)
	}
}
