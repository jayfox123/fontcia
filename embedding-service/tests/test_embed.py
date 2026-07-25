import io

from fastapi.testclient import TestClient
from PIL import Image

from main import app

client = TestClient(app)


def _make_test_image(color: tuple[int, int, int]) -> bytes:
    img = Image.new("RGB", (100, 100), color=color)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def test_embed_returns_a_384_length_vector():
    image_bytes = _make_test_image((255, 0, 0))
    response = client.post("/embed", files={"image": ("test.png", image_bytes, "image/png")})

    assert response.status_code == 200
    embedding = response.json()["embedding"]
    assert len(embedding) == 384
    assert all(isinstance(v, float) for v in embedding)


def test_embed_is_deterministic_for_the_same_image():
    image_bytes = _make_test_image((0, 255, 0))

    response_a = client.post("/embed", files={"image": ("test.png", image_bytes, "image/png")})
    response_b = client.post("/embed", files={"image": ("test.png", image_bytes, "image/png")})

    assert response_a.json()["embedding"] == response_b.json()["embedding"]


def test_embed_differs_for_visibly_different_images():
    red_image = _make_test_image((255, 0, 0))
    blue_image = _make_test_image((0, 0, 255))

    response_a = client.post("/embed", files={"image": ("a.png", red_image, "image/png")})
    response_b = client.post("/embed", files={"image": ("b.png", blue_image, "image/png")})

    assert response_a.json()["embedding"] != response_b.json()["embedding"]


def test_embed_rejects_invalid_image_data():
    response = client.post("/embed", files={"image": ("bad.png", b"not an image", "image/png")})

    assert response.status_code == 400
