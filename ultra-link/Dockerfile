# Ultra Link — app image (server + worker). Node 22 runs the TypeScript sources directly (type stripping).
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# never bake secrets into the image (.dockerignore drops .env); keys come from the environment at runtime
RUN rm -f .env && mkdir -p var/media && chown -R node:node var
USER node
EXPOSE 8080
CMD ["node", "src/server/main.ts"]
