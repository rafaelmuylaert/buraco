FROM node:18-alpine

# Set the main working directory
WORKDIR /app

# Copy the entire repository into the container
COPY . .

# Install dependencies for the server
WORKDIR /app/buraco-server
RUN npm ci --no-audit --no-fund

# Install dependencies and build the client
WORKDIR /app/buraco-client
RUN npm ci --no-audit --no-fund && npm run build

# Reset the default working directory back to the server
WORKDIR /app/buraco-server

# Default command (will be overridden by Compose for the client and bot)
CMD ["node", "server.js"]