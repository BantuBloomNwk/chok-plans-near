# The NEAR playground: docker build -f server/Dockerfile -t near-playground .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY deployment.json ./
COPY server/demo.mjs ./server/demo.mjs
COPY agent ./agent
COPY target/wasm32-unknown-unknown/release/token.wasm ./target/wasm32-unknown-unknown/release/token.wasm
USER node
CMD ["node", "server/demo.mjs"]
