FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/bot ./bot
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts/demo.mjs ./scripts/demo.mjs
COPY --from=build /app/scripts/handoff.mjs ./scripts/handoff.mjs
COPY --from=build /app/handoff ./handoff
USER node
EXPOSE 3000
CMD ["node", "server/main.mjs"]
