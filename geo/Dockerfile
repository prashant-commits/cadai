FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54

# OpenCASCADE (pulled in by build123d) loads these at import time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Model scripts drop to this uid. The server process stays root only so it
# can setuid; launch with --cap-drop ALL --cap-add SETUID --cap-add SETGID.
RUN useradd --create-home --uid 10002 --shell /usr/sbin/nologin georun

WORKDIR /app
COPY requirements.txt pyproject.toml ./
COPY cadai_geo ./cadai_geo
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps .

USER root
ENV HOME=/root \
    PORT=8000 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8000'), timeout=3)"
CMD ["sh", "-c", "exec uvicorn cadai_geo.service:app --host 0.0.0.0 --port ${PORT}"]
