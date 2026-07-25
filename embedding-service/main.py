import io

from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image
from transformers import AutoImageProcessor, AutoModel
import torch

app = FastAPI()

MODEL_NAME = "facebook/dinov2-small"
_processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
_model = AutoModel.from_pretrained(MODEL_NAME)
_model.eval()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/embed")
def embed(image: UploadFile = File(...)) -> dict[str, list[float]]:
    try:
        contents = image.file.read()
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    inputs = _processor(images=pil_image, return_tensors="pt")
    with torch.no_grad():
        outputs = _model(**inputs)

    # Mean-pool the last hidden state across all tokens (CLS + patches) to
    # get one fixed-length vector per image — pooling the CLS token alone
    # (index 0) is an equally common choice; this averages the whole grid
    # for a slightly more robust whole-image representation.
    embedding = outputs.last_hidden_state.mean(dim=1).squeeze().tolist()

    return {"embedding": embedding}
