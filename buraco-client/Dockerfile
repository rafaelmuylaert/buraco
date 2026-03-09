FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
# Expose the Vite port
ARG CLIENT_PORT=5173
ENV CLIENT_PORT=${CLIENT_PORT}
EXPOSE ${CLIENT_PORT}
CMD ["npm", "run", "dev", "--", "--host"]
