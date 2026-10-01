# Server image. TeX Live comes from one of two places (build arg TEXLIVE):
#   apt  (default) - Debian's texlive-full in the image (~5 GB, TeX Live 2022).
#   host - nothing in the image; a TeX Live installation is bind-mounted read-only
#          at /data/texlive (the path it was installed to). Used on the Pi, where
#          TeX Live 2025 lives on the SSD and the SD card stays free.
FROM node:24-bookworm-slim

ARG TEXLIVE=apt
# latexmk and several TeX Live scripts are Perl.
RUN apt-get update \
    && apt-get install -y --no-install-recommends perl ca-certificates pandoc \
    && if [ "$TEXLIVE" = "apt" ]; then apt-get install -y --no-install-recommends texlive-full latexmk; fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# esbuild is a dev dependency: build the client, then drop dev deps.
RUN node build.js && npm prune --omit=dev && mkdir -p /app/data && chown node:node /app/data

# A mounted TeX Live wins over the Debian one.
ENV PATH="/data/texlive/2025/bin/aarch64-linux:/data/texlive/2025/bin/x86_64-linux:${PATH}" \
    DATA_DIR=/app/data \
    NODE_ENV=production
USER node
EXPOSE 3077
CMD ["node", "server/index.js"]
