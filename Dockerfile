FROM node:20-alpine

# npm workspaces: install ALL deps from root, then build client
# All 3 services (server, client, bot) share this single built image.
WORKDIR /app

COPY . .

RUN npm ci --no-audit --no-fund && \
    npm --prefix buraco-client run build

# Server/bot run from here by default
WORKDIR /app/buraco-server

CMD ["node", "server.js"]