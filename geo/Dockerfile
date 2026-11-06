FROM python:3.12-slim

# OpenCASCADE (pulled in by build123d) loads these at import time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin geo

WORKDIR /app
COPY requirements.txt pyproject.toml ./
COPY cadai_geo ./cadai_geo
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps .

USER geo
ENV HOME=/home/geo \
    PORT=8000 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn cadai_geo.service:app --host 0.0.0.0 --port ${PORT}"]
