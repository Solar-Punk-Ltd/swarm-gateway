FROM node:lts-bullseye-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]