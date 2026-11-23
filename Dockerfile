# Oficina · servicio. Un proceso Node, SQLite en /app/data (monte un volumen ahí).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# Los datos de los inquilinos (bases SQLite, reportes, catálogos) viven en /app/inquilinos (con INQUILINOS)
# o en /app/data y /app/reportes (sin lista): monte ahí un volumen persistente del host. Sin la instrucción
# VOLUME: Railway la rechaza («use Railway Volumes»); docker-compose y Fly montan el suyo igual.
EXPOSE 4180
ENV PUERTO=4180
ENV SERVICIO_HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4180/api/inquilinos >/dev/null || exit 1
CMD ["node", "src/servicio/index.js"]
