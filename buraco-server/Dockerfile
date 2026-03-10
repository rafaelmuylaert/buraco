FROM node:20-alpine

RUN apk add --no-cache clang lld

WORKDIR /app
COPY buraco-server/package*.json ./
RUN npm install

COPY buraco-server/ .
COPY buraco-client/src/game.js ./game.js

RUN clang --target=wasm32 -O3 -nostdlib \
    -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
    -Wl,--import-memory \
    -o nn_engine.wasm nn_engine.cpp && \
    echo "✅ WASM compiled"

ARG SERVER_PORT=8000
ENV SERVER_PORT=${SERVER_PORT}
EXPOSE ${SERVER_PORT}
CMD ["node", "server.js"]
