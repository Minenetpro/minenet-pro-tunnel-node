FROM oven/bun:latest

WORKDIR /app

# Copy only what's needed
COPY package.json bun.lock tsconfig.json ./
COPY index.ts ./
COPY frps ./

# Ensure the frps binary is executable
RUN chmod +x /app/frps || true

# Install deps if any (safe if none)
RUN bun install --frozen-lockfile || true

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "index.ts"]


