# Hugging Face Docker Space for Tanpin.
# Build from the repository root:
#   docker build -f space/Dockerfile -t tanpin .
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY public ./public

ENV DEMO_MODE=1
ENV PORT=7860
ENV HOST=0.0.0.0

EXPOSE 7860

CMD ["node", "bin/tanpin", "serve"]
