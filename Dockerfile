FROM python:3.11-alpine

WORKDIR /app
COPY deploy/official_adapter.py ./official_adapter.py

ENV PORT=6768
EXPOSE 6768

CMD ["python3", "official_adapter.py"]
