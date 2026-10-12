# Server image. TeX Live comes from one of two places (build arg TEXLIVE):
#   apt  (default) - Debian's texlive-full in the image (~5 GB, TeX Live 2022).
#   host - nothing in the image; a TeX Live installation is bind-mounted read-only
#          at /data/texlive (the path it was installed to). Used on the Pi, where
#          TeX Live 2025 lives on the SSD and the SD card stays free.
# PANDOC=1 (default) installs pandoc for the Word/Markdown/HTML export. The image
# published on ghcr.io is built with PANDOC=0 (docs/INSTALL-DOCKER.md).
#
# Two stages: npm ci with dev and optional packages (esbuild, @napi-rs/canvas) only
# happens in the build stage, which is not part of the final image.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# With optional deps: esbuild needs its platform package (@esbuild/*).
RUN npm ci
COPY . .
# esbuild is a dev dependency: build the client, then drop dev deps and optional ones
# (@napi-rs/canvas: only pdf.js under Node needs it, the app runs pdf.js in the browser).
# npm prune leaves the emptied scope folders (@esbuild, @napi-rs) behind.
# pdfjs-dist: the client is bundled and build.js copies only build/pdf.worker.min.mjs,
# the rest (cmaps, fonts, legacy build, QuickJS sandbox ...) is never served.
RUN node build.js \
    && npm prune --omit=dev --omit=optional \
    && find node_modules -mindepth 1 -maxdepth 1 -type d -empty -delete \
    && cd node_modules/pdfjs-dist \
    && rm -rf cmaps standard_fonts legacy image_decoders web types build/pdf.sandbox*

FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="latex-web-ide" \
      org.opencontainers.image.description="Web-IDE fuer LaTeX-Projekte mit Live-Zusammenarbeit (AGPL-3.0-only). Drittsoftware, Paketliste und Quellcode-Angebot: /app/docs/INSTALL-DOCKER.md" \
      org.opencontainers.image.authors="felix-d-git" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/felix-d-git/latex-web-ide"

ARG TEXLIVE=apt
ARG PANDOC=1
# latexmk and several TeX Live scripts are Perl.
# The slim base keeps only /usr/share/doc/*/copyright; keep NOTICE files as well.
RUN printf 'path-include /usr/share/doc/*/NOTICE*\n' > /etc/dpkg/dpkg.cfg.d/zz-keep-notices \
    && apt-get update \
    && apt-get install -y --no-install-recommends perl ca-certificates \
    && if [ "$PANDOC" != "0" ]; then apt-get install -y --no-install-recommends pandoc; fi \
    && if [ "$TEXLIVE" = "apt" ]; then apt-get install -y --no-install-recommends texlive-full latexmk; fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app
# DEBIAN-PACKAGES.txt: exact versions for the source offer (docs/INSTALL-DOCKER.md),
# written after COPY so nothing from the build context can replace it.
RUN dpkg-query -W -f='${Package}\t${Version}\t${source:Package}\t${source:Version}\t${Built-Using}\t${Static-Built-Using}\n' > /app/DEBIAN-PACKAGES.txt \
    && mkdir -p /app/data && chown node:node /app/data

# A mounted TeX Live wins over the Debian one.
ENV PATH="/data/texlive/2025/bin/aarch64-linux:/data/texlive/2025/bin/x86_64-linux:${PATH}" \
    DATA_DIR=/app/data \
    NODE_ENV=production
USER node
EXPOSE 3077
CMD ["node", "server/index.js"]
