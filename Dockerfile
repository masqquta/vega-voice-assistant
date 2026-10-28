# Один сервис: API (/api/v1) + статика фронта. SQLite живёт на volume /data (DB_PATH=/data/app.db).
FROM node:24-bookworm-slim

# ffmpeg — перекодирование webm/mp4 → ogg/opus для SpeechKit; ca-certificates + сертификат НУЦ Минцифры для GigaChat
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && (curl -fsSL https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt -o /usr/local/share/ca-certificates/russian_trusted_root_ca.crt || echo "НУЦ недоступен — GigaChat без сертификата") \
 && update-ca-certificates \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package.json package-lock.json ./
# python3/make/g++ — на случай, если готовой сборки better-sqlite3 под платформу нет и её надо скомпилировать
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY data/seed_mini.json data/dataset.clean.csv ./data/

ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/app.db TZ_DEFAULT=Europe/Moscow MODEL_CACHE_DIR=/app/.cache/models
# Всё тяжёлое — при сборке, на мощной машине: скачать модель эмбеддингов (~130 МБ), собрать базу
# (демо + датасет ТЗ) и посчитать векторы. На free-хостинге ~0,1 CPU — там это заняло бы десятки минут,
# а так контейнер стартует с готовой базой (диск временный: каждый старт — снова эта, чистая).
RUN node scripts/import_dataset.js && node scripts/build_embeddings.js
EXPOSE 3000
# при старте: миграции и автосид пустой БД выполняет сам сервер
# импорт датасета идемпотентен: на временном диске (Render free) база собирается заново при каждом старте
CMD ["sh", "-c", "node scripts/import_dataset.js && node server/index.js"]
