FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Expose the API and WebSockets port
EXPOSE 8000
CMD ["node", "server.js"]
