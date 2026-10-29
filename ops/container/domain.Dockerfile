# syntax=docker/dockerfile:1.7
# Build-only artifact. Not included in the default K3s deployment or release set.
FROM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build
ARG COMMAND
WORKDIR /src
COPY go.work go.work.sum ./
COPY shared ./shared
COPY services ./services
RUN test "$COMMAND" = domain-gateway || test "$COMMAND" = domain-worker
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -trimpath -ldflags='-s -w' -o /server ./services/ky-org-service/cmd/${COMMAND}
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /server /server
USER 65532:65532
ENTRYPOINT ["/server"]
