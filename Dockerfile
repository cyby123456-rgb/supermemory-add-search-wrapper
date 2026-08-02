FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./

ENV PORT=6767
ENV SUPERMEMORY_DATA_FILE=/data/store.json
VOLUME ["/data"]
EXPOSE 6767

CMD ["node", "server.mjs"]
