FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
# Expose the Vite Preview port
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]
