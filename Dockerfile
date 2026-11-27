# Dalel in a container: the same single command, no Node.js needed on the host.
#   docker build -t dalel .
#   docker run --rm -v "$PWD:/work" --env-file .env dalel docs/requirements.md reports/report.md
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Documents are parsed as untrusted input, so the process does not run as root.
USER node
# Paths on the command line are relative to the mounted folder.
WORKDIR /work
ENTRYPOINT ["node", "/app/bin/dalel.mjs"]
CMD ["--help"]
