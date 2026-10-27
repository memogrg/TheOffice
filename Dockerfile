# Oficina · servicio. Un proceso Node, SQLite en /app/data (monte un volumen ahí).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# Los datos de los inquilinos (bases SQLite, reportes, catálogos) viven aquí: volumen persistente.
VOLUME ["/app/data", "/app/inquilinos", "/app/reportes"]
EXPOSE 4180
ENV PUERTO=4180
ENV SERVICIO_HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4180/api/inquilinos >/dev/null || exit 1
CMD ["node", "src/servicio/index.js"]
