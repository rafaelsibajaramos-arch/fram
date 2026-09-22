FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache dumb-init wget

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs ./
COPY public ./public

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/system/health >/dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
