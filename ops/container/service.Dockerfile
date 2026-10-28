# syntax=docker/dockerfile:1.7
FROM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build
ARG SERVICE
WORKDIR /src
COPY go.work go.work.sum ./
COPY shared ./shared
COPY services ./services
RUN test "$SERVICE" = ky-auth-service || test "$SERVICE" = ky-org-service || test "$SERVICE" = ky-membership-service || test "$SERVICE" = ky-matrix-account-service || test "$SERVICE" = ky-ai-model-service
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -trimpath -ldflags='-s -w' -o /server ./services/${SERVICE}/cmd/server
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /server /server
USER 65532:65532
ENTRYPOINT ["/server"]
