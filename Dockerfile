FROM node:lts-bullseye-slim@sha256:f7818cba7c85740e6f9dd31553636131d01e9992fb7d112b9b0893afd884d1d6

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]