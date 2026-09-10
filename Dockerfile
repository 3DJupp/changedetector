# Development image. Production runs on Cloudflare's edge, not in a container:
# `npm run deploy` ships the Worker itself.
FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .

EXPOSE 8787
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787"]
