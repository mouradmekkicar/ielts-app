# Portable container image — works on Fly.io, Google Cloud Run, Railway,
# Azure Container Apps, Docker, etc.
FROM node:20-alpine
WORKDIR /app

# Install only production deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# server.js listens on process.env.PORT (falls back to 8787).
# Cloud Run/Heroku/Railway set PORT automatically; this default covers the rest.
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
