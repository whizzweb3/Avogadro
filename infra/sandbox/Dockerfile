# Separate image for untrusted execution. Node is included only to execute the
# fixed isolation probes; there are no application packages or service clients.
FROM node:22.14.0-bookworm-slim
ENV HOME=/tmp npm_config_cache=/tmp/npm-cache
ARG TARGETARCH=amd64
RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/foundry /usr/local/bin /opt/avogadro /work \
    && curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.tar.gz -o /tmp/foundry/foundry_v1.8.5_linux_amd64.tar.gz \
    && curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.sha256 -o /tmp/foundry/foundry.sha256 \
    && (cd /tmp/foundry && sha256sum -c foundry.sha256) \
    && tar -xzf /tmp/foundry/foundry_v1.8.5_linux_amd64.tar.gz -C /usr/local/bin \
    && curl -fsSL 'https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/solc-linux-amd64-v0.8.26+commit.8a97fa7a' -o /usr/local/bin/solc \
    && echo 'd5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef  /usr/local/bin/solc' | sha256sum -c - \
    && chmod 0755 /usr/local/bin/solc \
    && forge --version | grep -F 'Version: 1.8.5' \
    && solc --version | grep -F 'Version: 0.8.26+commit.8a97fa7a' \
    && chown 10001:10001 /work \
    && chmod 0555 /opt/avogadro \
    && rm -rf /tmp/foundry
COPY --chmod=0555 run-in-container.sh /opt/avogadro/run-in-container
COPY --chmod=0444 isolation-probe.mjs /opt/avogadro/isolation-probe.mjs
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/avogadro/run-in-container"]
