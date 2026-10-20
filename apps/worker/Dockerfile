FROM node:22.14.0-alpine3.21
ENV NODE_ENV=production
WORKDIR /app
COPY apps/worker/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=10001:10001 apps/worker/src ./src
USER 10001:10001
CMD ["node", "src/index.mjs"]
