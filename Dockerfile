# Always-on remote server: real Chrome on a virtual display (Xvfb), MCP over HTTP on :8787.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci \
 && npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
 && rm -rf /var/lib/apt/lists/* \
 && npm prune --omit=dev
ENV GPT_IMAGE_HOME=/data \
    GPT_IMAGE_BROWSER_CHANNEL=chromium \
    GPT_IMAGE_HEADLESS=0 \
    GPT_IMAGE_WINDOW=normal \
    GPT_IMAGE_HTTP_HOST=0.0.0.0 \
    GPT_IMAGE_HTTP_PORT=8787
VOLUME /data
EXPOSE 8787
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x900x24", "node", "dist/cli.js", "serve", "--http"]
