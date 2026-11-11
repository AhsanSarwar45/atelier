# Stage 1: Build Next.js frontend (static export)
FROM node:20-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY next.config.js tsconfig.json tailwind.config.ts postcss.config.js components.json ./
COPY src ./src
COPY public ./public
RUN npx next build

# Stage 2: Build Rust backend + run integration tests
FROM rust:slim-bookworm
RUN apt-get update && apt-get install -y curl git python3 pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY --from=frontend /app/out /app/out
WORKDIR /app/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release
COPY tests/integration/run-tests.sh /app/tests/run-tests.sh
RUN chmod +x /app/tests/run-tests.sh
WORKDIR /app
CMD ["/app/tests/run-tests.sh"]
