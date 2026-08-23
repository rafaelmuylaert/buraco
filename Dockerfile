FROM node:20-alpine

# npm workspaces: install ALL deps from root, then build client
# All 3 services (server, client, bot) share this single built image.
# Hoisted node_modules binaries must be on PATH for npm run / npx / direct usage.
ENV PATH="/app/node_modules/.bin:${PATH}"

WORKDIR /app

# Copy the git-driven entrypoint (auto-pulls on update, installs deps, starts service)
COPY deploy/entrypoint.sh /usr/local/bin/git-entrypoint.sh
RUN chmod +x /usr/local/bin/git-entrypoint.sh

COPY . .

RUN npm ci --no-audit --no-fund && \
    npm --prefix buraco-client run build

# Server/bot run from here by default
WORKDIR /app/buraco-server

ENTRYPOINT ["/usr/local/bin/git-entrypoint.sh"]
CMD ["server"]