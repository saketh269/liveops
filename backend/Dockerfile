FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY . .
RUN pip install --no-cache-dir . && useradd --create-home --uid 10001 liveops
USER liveops
EXPOSE 8000
# Run migrations, then the API. Saved sources and mappings survive every update.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
