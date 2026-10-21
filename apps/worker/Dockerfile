FROM node:22.14.0-bookworm-slim
ENV NODE_ENV=production HOME=/tmp npm_config_cache=/tmp/npm-cache
WORKDIR /workspace
ARG TARGETARCH=amd64
RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/foundry /usr/local/bin \
    && curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.tar.gz -o /tmp/foundry/foundry.tar.gz \
    && curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.sha256 -o /tmp/foundry/foundry.sha256 \
    && (cd /tmp/foundry && sha256sum -c foundry.sha256) \
    && tar -xzf /tmp/foundry/foundry.tar.gz -C /usr/local/bin \
    && curl -fsSL 'https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/solc-linux-amd64-v0.8.26+commit.8a97fa7a' -o /usr/local/bin/solc \
    && echo 'd5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef  /usr/local/bin/solc' | sha256sum -c - \
    && chmod 0755 /usr/local/bin/solc \
    && forge --version | grep -F 'Version: 1.8.5' \
    && solc --version | grep -F 'Version: 0.8.26+commit.8a97fa7a' \
    && rm -rf /tmp/foundry
ENV AVOGADRO_FORGE_BIN=/usr/local/bin/forge AVOGADRO_SOLC_BIN=/usr/local/bin/solc
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/artifacts/package.json packages/artifacts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/runner/package.json packages/runner/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace @avogadro/worker && npm cache clean --force \
    && chown -R 10001:10001 /workspace
COPY --chown=10001:10001 apps/worker/src apps/worker/src
COPY --chown=10001:10001 packages/artifacts/src packages/artifacts/src
COPY --chown=10001:10001 packages/db/src packages/db/src
COPY --chown=10001:10001 packages/ingestion/src packages/ingestion/src
COPY --chown=10001:10001 packages/runner/src packages/runner/src
COPY --chown=10001:10001 packages/shared/src packages/shared/src
COPY --chown=10001:10001 packages/contracts packages/contracts
USER 10001:10001
CMD ["npm", "run", "start", "--workspace", "@avogadro/worker"]
