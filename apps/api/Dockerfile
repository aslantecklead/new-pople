FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/tts \
  && /opt/tts/bin/pip install --no-cache-dir piper-tts==1.8.0
RUN mkdir -p /opt/voices && cd /opt/voices \
  && /opt/tts/bin/python -m piper.download_voices ru_RU-irina-medium
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install --workspace=@factory/api
COPY apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 8080
CMD ["npm", "run", "start"]
