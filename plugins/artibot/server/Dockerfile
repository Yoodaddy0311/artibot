FROM node:20-slim

WORKDIR /app

# Copy all source files
COPY package.json index.js store.js merge.js ./

# Cloud Run uses PORT env var (default 8080)
ENV PORT=8080
ENV NODE_ENV=production

# Run as non-root
USER node

EXPOSE 8080

CMD ["node", "index.js"]
