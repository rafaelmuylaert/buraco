FROM node:20-alpine

WORKDIR /app
COPY buraco-server/package*.json ./

RUN npm install

COPY buraco-server/ .
COPY buraco-client/src/game.js ./game.js

# Install clang/lld and recompile the WASM binary from source
RUN apk add --no-cache clang lld && \
    clang --target=wasm32 -O3 -flto -nostdlib \
      -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
      -Wl,--import-memory \
      -msimd128 \
      -o nn_engine.wasm nn_engine.cpp && \
    apk del clang lld

# Expose the API and WebSockets port
EXPOSE 8000
CMD ["node", "server.js"]
