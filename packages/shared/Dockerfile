FROM node:24-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy workspace configuration
COPY package.json ./

# Copy shared package configuration
COPY packages/shared/package.json ./packages/shared/

# Install dependencies.
# NOTE: unlike `pnpm install --filter @lukittu/shared...`, npm has no partial
# workspace-closure install: `--workspace` still resolves against the full
# package-lock.json but only links/builds deps for the given workspace (plus
# the declared root deps). Since @lukittu/shared has no dependency on
# apps/web or apps/bot, the result is equivalent here; it is NOT a general
# substitute for pnpm's dependency-closure filtering in other workspaces.
COPY package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci --workspace=packages/shared

# Build migration image
FROM base AS migration
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Copy shared package source
COPY packages/shared ./packages/shared

# Generate Prisma client
WORKDIR /app/packages/shared
RUN npm run generate

# Set default working directory
WORKDIR /app/packages/shared

# Default command runs migrations
CMD ["npm", "run", "deploy"]
