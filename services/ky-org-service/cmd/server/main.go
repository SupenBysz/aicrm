package main

import (
	"context"
	"log"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/server"
)

func main() {
	ctx := context.Background()
	cfg := config.Load("ky-org-service", ":18082", "KY_ORG_SERVICE_HTTP_ADDR")
	app := server.New(cfg)
	if err := app.Run(ctx); err != nil {
		log.Fatalf("%s stopped with error: %v", cfg.ServiceName, err)
	}
}
