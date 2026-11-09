FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "server.js"]
