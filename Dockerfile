# Server image for the Pi. TeX Live 2025 (scheme-full) is NOT in the image:
# it lives on the SSD and is bind-mounted read-only at /data/texlive
# (the path it was installed to) - keeps the image small and the SD card free.
FROM node:24-bookworm-slim

# latexmk and several TeX Live scripts are Perl.
RUN apt-get update && apt-get install -y --no-install-recommends perl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# esbuild is a dev dependency: build the client, then drop dev deps.
RUN node build.js && npm prune --omit=dev

ENV PATH="/data/texlive/2025/bin/aarch64-linux:${PATH}" \
    DATA_DIR=/app/data \
    NODE_ENV=production
USER node
EXPOSE 3077
CMD ["node", "server/index.js"]
