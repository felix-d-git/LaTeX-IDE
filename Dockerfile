# Server image. TeX Live comes from one of two places (build arg TEXLIVE):
#   apt  (default) - Debian's texlive-full in the image (~5 GB, TeX Live 2022).
#   host - nothing in the image; a TeX Live installation is bind-mounted read-only
#          at /data/texlive (the path it was installed to). Used on the Pi, where
#          TeX Live 2025 lives on the SSD and the SD card stays free.
FROM node:24-bookworm-slim

LABEL org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/felix-d-git/latex-web-ide"

ARG TEXLIVE=apt
# latexmk and several TeX Live scripts are Perl.
# DEBIAN-PACKAGES.txt: exact versions for the GPL source offer (docs/INSTALL-DOCKER.md).
RUN apt-get update \
    && apt-get install -y --no-install-recommends perl ca-certificates pandoc \
    && if [ "$TEXLIVE" = "apt" ]; then apt-get install -y --no-install-recommends texlive-full latexmk; fi \
    && mkdir -p /app \
    && dpkg-query -W -f='${Package} ${Version} ${source:Package} ${source:Version}\n' > /app/DEBIAN-PACKAGES.txt \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# esbuild is a dev dependency: build the client, then drop dev deps and optional ones
# (@napi-rs/canvas: only pdf.js under Node needs it, the app runs pdf.js in the browser).
RUN node build.js && npm prune --omit=dev --omit=optional && mkdir -p /app/data && chown node:node /app/data

# A mounted TeX Live wins over the Debian one.
ENV PATH="/data/texlive/2025/bin/aarch64-linux:/data/texlive/2025/bin/x86_64-linux:${PATH}" \
    DATA_DIR=/app/data \
    NODE_ENV=production
USER node
EXPOSE 3077
CMD ["node", "server/index.js"]
