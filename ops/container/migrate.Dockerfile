FROM postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5
WORKDIR /app
COPY ops/db /app/ops/db
COPY scripts/deploy_database.sh /app/scripts/deploy_database.sh
USER postgres
ENTRYPOINT ["bash", "/app/scripts/deploy_database.sh"]
