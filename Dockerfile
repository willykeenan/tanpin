# Self-hosted image. Requests reach the container through a port mapping, so
# they are not "local" and need an API key: run with
#   docker run -p 4173:4173 -e TANPIN_ADMIN_KEY=<long random string> -v tanpin-data:/app/data tanpin
# and paste that key into the dashboard's prompt. (space/Dockerfile is the
# public demo image, DEMO_MODE=1.)
FROM node:22-alpine
LABEL io.modelcontextprotocol.server.name="io.github.willykeenan/tanpin"
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY docs ./docs
COPY LICENSE ./
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173
USER node
CMD ["node", "bin/tanpin", "serve"]
