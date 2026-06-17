FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p ./

FROM node:20-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/out ./out
COPY public/ ./public/
RUN mkdir -p data
EXPOSE 4319
CMD ["node", "out/server.js"]
