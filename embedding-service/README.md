# embedding-service

FastAPI microservice wrapping `facebook/dinov2-small` (via Hugging Face `transformers`) as a fixed feature extractor. Internal-only — called by `server/`, not exposed to the browser extension directly. No training happens here; the model is loaded pretrained.

## Setup

```bash
python -m venv venv
venv\Scripts\activate      # Windows; use `source venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
```

First run of anything that imports the model (tests, the real server) downloads the DINOv2-small weights (~100MB) from Hugging Face and caches them under `~/.cache/huggingface`. This requires internet access and is slow only the first time.

## Running

```bash
uvicorn main:app --port 8000
```

`GET /health` → `{"status": "ok"}`. `POST /embed` (multipart, field `image`) → `{"embedding": [...]}` (384 floats).

## Tests

```bash
pytest -v
```
