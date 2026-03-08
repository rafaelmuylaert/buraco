FROM node:20-alpine

WORKDIR /app
COPY buraco-server/package*.json ./

RUN npm install

COPY buraco-server/ .
COPY buraco-client/src/game.js ./game.js

# Expose the API and WebSockets port
EXPOSE 8000
CMD ["node", "server.js"]
