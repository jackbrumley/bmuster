# BMuster server image (docs/specs/SPEC-HOSTING.md, docs/hosting.md).
#
# Built FROM the release archives, not from source, so the image runs exactly
# what the archives hold. The build context is a folder with one unpacked
# Linux archive per architecture:
#
#   <context>/amd64/bmuster-server/   from bmuster-server-linux-x64.tar.gz
#   <context>/arm64/bmuster-server/   from bmuster-server-linux-arm64.tar.gz
#
# The release workflow fills it; for a local image, `npm run docker:local`
# does it from `npm run release:server-local`. Only the archive's app/ and
# releases/ are used: the image brings its own Node, and Docker is the
# service, so the archive's node/ and launcher are left out.
#
# No RUN step runs on the target architecture, so a multi-arch build needs no
# QEMU emulation.

# Must match .node-version, the Node the archives are tested with (the
# workflow passes it). Debian (glibc), not Alpine (musl): better-sqlite3 and
# @node-rs/argon2 ship glibc builds, and the archives hold those.
ARG NODE_VERSION=26.13.0

# The data folder, made on the build machine with the image user's ids, so
# the runtime stage can copy it in already owned by that user.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS folders
RUN mkdir -p /out/data

FROM node:${NODE_VERSION}-bookworm-slim

ARG TARGETARCH
ARG BMUSTER_VERSION=unknown

LABEL org.opencontainers.image.title="BMuster" \
      org.opencontainers.image.description="Self-hosted remote desktop, terminal and inventory server" \
      org.opencontainers.image.source="https://github.com/jackbrumley/bmuster" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${BMUSTER_VERSION}"

# Program files belong to root and are read-only to the server; only /data is
# its own. `node` (uid 1000) is the image's built-in unprivileged user.
COPY ${TARGETARCH}/bmuster-server/app /opt/bmuster/app
COPY ${TARGETARCH}/bmuster-server/releases /opt/bmuster/releases
COPY --from=folders --chown=node:node /out/data /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/data/bmuster.db \
    RELEASES_PATH=/opt/bmuster/releases

# Behind a reverse proxy (adapter-node's settings; see docs/hosting.md).
# The client address is read from X-Forwarded-For, counting proxies from the
# right. Each trusted proxy appends the address it was reached from, so with
# Nginx Proxy Manager in front of Coolify's Traefik the client is the second
# entry from the right: XFF_DEPTH=2. One proxy only: set XFF_DEPTH=1. The
# depth must match the real chain, or a client can choose its own address
# (too high) or every client looks like the proxy (too low).
ENV ADDRESS_HEADER=X-Forwarded-For \
    XFF_DEPTH=2 \
    PROTOCOL_HEADER=x-forwarded-proto \
    HOST_HEADER=x-forwarded-host
# The two headers give the request's origin (https://<the public name>),
# which the cross-site checks compare with the browser's. adapter-node 6
# has no ORIGIN variable, so the proxies must pass them (docs/hosting.md).
# BMUSTER_LOCAL_NETWORK_MODE stays unset: TLS ends at the proxy.

# adapter-node refuses request bodies above 512 KB by default. File transfers
# send 8 MB chunks; 16 MB leaves room for a chunk and its framing and still
# bounds what one request can make the server hold in memory.
ENV BODY_SIZE_LIMIT=16M

ENV BMUSTER_DEPLOYMENT=docker
WORKDIR /opt/bmuster/app
USER node
VOLUME /data
EXPOSE 8080

# Readiness: the database answers and every migration is applied. Nothing
# listens until the server holds the data lock (a second container on the
# same volume waits, up to 120 s), so a waiting container stays "starting"
# for the whole start period, and Traefik sends it nothing. Checks every 2 s
# while starting, so the new server takes traffic soon after the old one
# stops. Node's own fetch, so the image needs no curl.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# server.js handles SIGTERM itself (closes the listener, then exits), so it
# runs as PID 1 directly. Migrations run at start-up, relative to WORKDIR.
CMD ["node", "server.js"]
