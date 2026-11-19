# Dockerfile untuk proxy InnerTube Laras di Railway (egress P2b).
#
# Tanpa dependensi: server.js hanya memakai modul `http` bawaan Node,
# jadi tidak ada `npm install` (build tidak bisa gagal karena registry).
# Railway mendeteksi Dockerfile otomatis dan memakainya sebagai builder.
# Railway menyuntik PORT; server.js membacanya dari environment.
FROM node:24-alpine

WORKDIR /app

COPY package.json server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
