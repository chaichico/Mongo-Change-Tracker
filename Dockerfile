FROM node:20-alpine

WORKDIR /app

# Install production dependencies first so Docker can reuse this layer.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=4400

EXPOSE 4400

CMD ["npm", "start"]
