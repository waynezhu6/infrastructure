FROM node:22.22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:22.22-alpine
# The deployer drives the host's Docker through its socket, with the same CLI
# and compose plugin an admin would use by hand, copied from Docker's own image.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist
COPY app.compose.yml ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
