FROM node:20-alpine

WORKDIR /app

# Install only production dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source.
COPY . .

# Ensure SQLite data directories exist.
RUN mkdir -p /app/data /data

# Point app storage to Railway volume mount path.
ENV DATA_DIR=/data
ENV NODE_ENV=production
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "src/app.js"]
