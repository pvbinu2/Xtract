FROM node:20

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/xtract-apps/start-apps.sh /app/apps/xtract-apps/start-apps.sh
RUN chmod +x /app/apps/xtract-apps/start-apps.sh

CMD ["/app/apps/xtract-apps/start-apps.sh"]
