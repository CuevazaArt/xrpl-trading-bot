# Usar una imagen base ligera de Node.js
FROM node:20-alpine

# No ejecutar como root en producción
RUN addgroup -S helena && adduser -S helena -G helena

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias primero para aprovechar el caché
COPY package*.json tsconfig.json ./

# Instalar SOLO dependencias de producción (builds reproducibles)
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copiar código fuente
COPY src/ ./src/

# Compilar TypeScript a JavaScript
RUN npm run build

# Crear directorio para persistencia de la base de datos
RUN mkdir -p data && chown -R helena:helena /app

# Cambiar a usuario no-root
USER helena

# Variables de entorno de producción
ENV NODE_ENV=production

# Exponer el puerto del dashboard web
EXPOSE 3000

# Health check: verificar que el proceso responde
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/state').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Comando para iniciar la aplicación en producción
CMD ["node", "dist/index.js"]
