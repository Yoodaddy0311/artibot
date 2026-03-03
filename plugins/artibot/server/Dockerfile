FROM node:20-slim

WORKDIR /app

# Copy all source files
COPY package.json index.js store.js merge.js file-store.js ./

# Create data directory for persistence
RUN mkdir -p /app/data && chown node:node /app/data

# Cloud Run uses PORT env var (default 8080)
ENV PORT=8080
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Run as non-root
USER node

EXPOSE 8080

CMD ["node", "index.js"]
