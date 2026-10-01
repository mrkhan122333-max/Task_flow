# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
#  Cosmic Info Solutions — Task Management
#  Single-stage production image for the Node/Express app.
#
#  Build:  docker build -t cosmic-tasks .
#  Run:    docker run -d --name cosmic-tasks -p 4321:4321 \
#            --env-file .env -v cosmic-data:/app/data -v cosmic-uploads:/app/uploads \
#            cosmic-tasks
#
#  The image runs as a non-root user and stores all state under /app/data and
#  /app/uploads, which must be mounted on persistent volumes.
# ---------------------------------------------------------------------------
FROM node:20-alpine

# tini gives us correct signal handling so SIGTERM reaches Node and the graceful
# shutdown in server.js actually runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=4321 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    UPLOAD_DIR=/app/uploads

WORKDIR /app

# Install dependencies first so the layer is cached across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Create the persistent directories and hand them to the unprivileged user.
RUN mkdir -p /app/data /app/uploads \
 && chown -R node:node /app

USER node

EXPOSE 4321

# The API exposes a lightweight health endpoint for load balancers / uptime checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||4321,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
