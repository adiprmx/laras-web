# Laras Web — proxy InnerTube via Fly.io. Tanpa dependensi:
# hanya Node bawaan (server.js memakai modul http saja).
FROM node:24-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
