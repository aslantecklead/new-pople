FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg espeak-ng fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install --workspace=@factory/api
COPY apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 8080
CMD ["npm", "run", "start"]
