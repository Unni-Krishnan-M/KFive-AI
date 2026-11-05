FROM node:22-bookworm-slim
RUN node -e "require('fs').writeFileSync('/tmp/node-ca.pem', require('tls').rootCertificates.join('\\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-ca.pem update \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-ca.pem install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node processor.cjs server.cjs ./
USER node
ENV NODE_ENV=production
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.cjs"]
