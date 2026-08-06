FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    libgl1 \
    libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/functions/docling-markdown

COPY functions/docling-markdown/requirements.txt ./requirements.txt
RUN python3 -m venv /opt/docling-markdown-venv \
  && /opt/docling-markdown-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/docling-markdown-venv/bin/pip install --no-cache-dir -r requirements.txt \
  && npm install -g azure-functions-core-tools@4 --unsafe-perm true

COPY functions/docling-markdown/host.json ./host.json
COPY functions/docling-markdown/function_app.py ./function_app.py

ENV PATH="/opt/docling-markdown-venv/bin:${PATH}"
ENV FUNCTIONS_WORKER_RUNTIME=python

CMD ["func", "start", "--python", "--host", "0.0.0.0", "--port", "7072"]
