# Build native Tree-sitter modules and generate the Prisma client with Node 24.
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma

# Prisma is a runtime dependency so this production-only install also includes
# the CLI used by `npm run db:deploy`. Install without lifecycle scripts first:
# tree-sitter 0.21 hard-codes C++17, but Node 24 headers require C++20.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && sed -i 's/-std=c++17/-std=c++20/g' node_modules/tree-sitter/binding.gyp \
    && npm rebuild --no-audit --no-fund \
    && npm run db:generate


# Runtime image contains only production npm dependencies and required OS tools.
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssl libstdc++6 libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*

# Seed a node-owned mount point for retained clones. An empty named Docker
# volume mounted here inherits these permissions; bind mounts must be chowned.
RUN mkdir -p /var/lib/codecompass/repository-storage \
    && chown -R node:node /var/lib/codecompass

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

# API is the default process; worker services override this command.
CMD ["npm", "start"]
