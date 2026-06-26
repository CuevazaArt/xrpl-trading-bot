# Usar una imagen base ligera de Node.js
FROM node:20-alpine

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias primero para aprovechar el caché
COPY package*.json tsconfig.json ./

# Instalar dependencias
RUN npm install

# Copiar código fuente
COPY src/ ./src/

# Compilar TypeScript a JavaScript
RUN npm run build

# Crear directorio para persistencia de la base de datos
RUN mkdir -p data

# Exponer el puerto del dashboard web
EXPOSE 3000

# Comando para iniciar la aplicación en producción
CMD ["npm", "start"]
