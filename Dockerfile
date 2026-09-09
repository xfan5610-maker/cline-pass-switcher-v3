FROM node:22-alpine
WORKDIR /app
COPY package.json server-v3.js ./
COPY public ./public
ENV DATA_DIR=/data
ENV BIND_HOST=0.0.0.0
VOLUME /data
EXPOSE 3123
CMD ["node", "server-v3.js"]
