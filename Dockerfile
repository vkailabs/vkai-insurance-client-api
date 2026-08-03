# --- Build stage: install dependencies & generate Prisma client ---
FROM node:20-slim AS build

# Prisma needs OpenSSL to load its query engine.
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (postinstall runs `prisma generate` needs the schema).
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Generate the Prisma client against the schema.
RUN npx prisma generate

# --- Runtime stage ---
FROM node:20-slim AS runtime

RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Bring over installed deps (incl. generated Prisma client) and app source.
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 4000

# Entrypoint applies migrations, then starts the API.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
