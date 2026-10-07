FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LIVEOPS_DATA_DIR=/data
COPY . .
RUN pip install --no-cache-dir . \
 && useradd --create-home --uid 10001 liveops \
 && mkdir -p /data && chown liveops:liveops /data
USER liveops
# Uploaded CSV/Excel files and webhook journals live here; compose mounts a volume (LIVEOPS-65).
VOLUME ["/data"]
EXPOSE 8000
# Run migrations, then the API. Saved sources and mappings survive every update.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
