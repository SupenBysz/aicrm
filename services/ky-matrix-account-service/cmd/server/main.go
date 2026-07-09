package main

import (
	"context"
	"log"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/server"
)

func main() {
	ctx := context.Background()
	cfg := config.Load("ky-matrix-account-service", ":18085", "KY_MATRIX_ACCOUNT_SERVICE_HTTP_ADDR")
	app := server.New(cfg)
	if err := app.Run(ctx); err != nil {
		log.Fatalf("%s stopped with error: %v", cfg.ServiceName, err)
	}
}
