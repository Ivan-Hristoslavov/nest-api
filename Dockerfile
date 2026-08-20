# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
#
# Kept separate from the runtime so the image that ships carries no compiler,
# no TypeScript and no dev dependencies — roughly a third of the size, and a
# much smaller surface for anything that gets into it later.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# The lockfile is copied on its own first, so this layer is only rebuilt when
# dependencies actually change rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `prebuild` runs `build:css`, so the Tailwind stylesheet is generated here.
# Without it the interface serves unstyled — see the boot check in main.ts.
RUN npm run build


# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Production dependencies only. `--ignore-scripts` because nothing here needs
# a package's postinstall to run, and an install script is a straightforward
# way for a compromised dependency to reach a production image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
# `public/` carries the built stylesheet, so it comes from the build stage
# rather than from the source tree — the repository deliberately does not
# track generated CSS.
COPY --from=build /app/public ./public

# Node's own unprivileged user, rather than root. Nothing in here writes to
# disk, so read-only ownership is all it needs.
USER node

EXPOSE 3000

# The container is healthy when the app answers its own probe. Compose,
# Kubernetes and most hosts read this and will not route traffic until it
# passes — which, on a bad database URL, is the difference between a failed
# deploy and a live site returning 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `start:prod` runs `node dist/main` directly rather than through npm, so
# SIGTERM reaches the process and NestJS's shutdown hooks close the database
# pool and stop the cron jobs instead of being killed mid-sweep.
CMD ["node", "dist/main"]
