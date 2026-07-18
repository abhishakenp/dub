FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY schema.sql ./schema.sql
EXPOSE 7181
CMD ["node", "server/index.mjs"]
