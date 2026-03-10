FROM mcr.microsoft.com/playwright:v1.53.2-jammy

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source.
COPY . .

# Ensure SQLite data directories exist.
RUN mkdir -p /app/data /data
RUN npm run playwright:verify

# Point app storage to Railway volume mount path.
ENV DATA_DIR=/data
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "src/app.js"]
