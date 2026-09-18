# One image, many roles.
#
# Every service shares the same source tree and differs only in entrypoint, so a
# single image keeps them provably in lockstep: the API and the worker can never
# be running different versions of the ledger.

FROM node:22-alpine AS base
WORKDIR /app
# dumb-init reaps zombies and forwards signals, so SIGTERM actually reaches node
# and graceful shutdown runs.
RUN apk add --no-cache dumb-init

FROM base AS deps
COPY package.json package-lock.json ./
# npm ci installs exactly the lockfile, which is what makes a build reproducible.
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Typecheck, then COMPILE to JavaScript.
#
# Production must not depend on node --experimental-strip-types: it only erases
# types and silently rejects any syntax that would need code generated
# (parameter properties, enums, namespaces). That exact gap once killed every
# service at startup while the test suite stayed green, because tsc and vitest
# both transpile and neither reproduces the runtime's behaviour. Compiling ahead
# of time removes the class of failure rather than guarding against it.
RUN npx tsc --noEmit \
 && node apps/admin/build.mjs \
 && npx tsc --project tsconfig.build.json

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
COPY --from=build /app/apps/admin/public ./dist/apps/admin/public
COPY --from=build /app/apps/mini-app/public ./dist/apps/mini-app/public
COPY --from=build /app/package.json ./

# Never run as root: a container escape should not begin with uid 0.
USER node

# SERVICE selects the role. Defaults to the API.
ENV SERVICE=api
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node dist/apps/${SERVICE}/src/main.js"]
