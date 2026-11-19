# syntax=docker/dockerfile:1
# Laras Web — proxy InnerTube player di Hugging Face Spaces (Docker SDK).
# Tanpa dependensi npm: hanya Node bawaan + server.js. Build tidak bisa
# gagal karena registry. HF Spaces mewajibkan aplikasi mendengarkan
# port 7860 (lihat server.js: PORT default 7860).
FROM node:22-alpine

WORKDIR /app
COPY server.js ./server.js

# HF Spaces (Docker SDK): port 7860 adalah satu-satunya port yang
# diekspos ke publik.
EXPOSE 7860

# Node langsung, tanpa package.json / npm install.
CMD ["node", "server.js"]
