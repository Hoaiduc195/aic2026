FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
COPY apps/__init__.py apps/__init__.py
COPY apps/inference apps/inference
RUN pip install --no-cache-dir ./apps/inference
USER 65532:65532
EXPOSE 8000
CMD ["uvicorn", "apps.inference.src.api:app", "--host", "0.0.0.0", "--port", "8000"]
