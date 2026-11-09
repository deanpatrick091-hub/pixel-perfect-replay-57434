# Build from the repository root:  docker build -f worker/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY src/lib/market ./src/lib/market
COPY worker/package.json ./worker/package.json
RUN cd worker && npm install --omit=dev
COPY worker ./worker
WORKDIR /app/worker
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
