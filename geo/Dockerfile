FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54

# OpenCASCADE (pulled in by build123d) loads these at import time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# The server stays root so it can drop privileges. It fails startup if any
# of these are missing from CapEff:
#   SETUID, SETGID — setuid to a per-run uid and to geotrust
#   KILL — kill another uid (process group and the uid-wide reap)
#   CHOWN — hand the work tree to the run uid, then scratch to geotrust
#   DAC_OVERRIDE, FOWNER — read and remove another uid's mode-0700 trees
# Launch with:
#   --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
#     --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER
# georun (10002) is only the manual EACCES check. Runs use cadairun0..3
# (uids 10100..10103, CADAI_GEO_UID_BASE). The trusted stage uses geotrust.
RUN useradd --create-home --uid 10002 --shell /usr/sbin/nologin georun \
    && useradd --uid 10003 --no-create-home --shell /usr/sbin/nologin geotrust \
    && useradd --uid 10100 --no-create-home --shell /usr/sbin/nologin cadairun0 \
    && useradd --uid 10101 --no-create-home --shell /usr/sbin/nologin cadairun1 \
    && useradd --uid 10102 --no-create-home --shell /usr/sbin/nologin cadairun2 \
    && useradd --uid 10103 --no-create-home --shell /usr/sbin/nologin cadairun3

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8000'), timeout=3)"
CMD ["sh", "-c", "exec uvicorn cadai_geo.service:app --host 0.0.0.0 --port ${PORT}"]
