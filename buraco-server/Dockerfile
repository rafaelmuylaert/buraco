FROM node:20-alpine

WORKDIR /app
COPY buraco-server/package*.json ./

RUN npm install

COPY buraco-server/ .
COPY buraco-client/src/game.js ./game.js

# Expose the API and WebSockets port
ARG SERVER_PORT=8000
ENV SERVER_PORT=${SERVER_PORT}
EXPOSE ${SERVER_PORT}
CMD ["node", "server.js"]
