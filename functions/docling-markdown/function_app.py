import base64
import json
import logging
import tempfile
from pathlib import Path

import azure.functions as func
from docling.document_converter import DocumentConverter


app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)
converter = DocumentConverter()


def _json_response(payload: dict, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
    )


@app.route(route="extract-markdown", methods=["POST"])
def extract_markdown(req: func.HttpRequest) -> func.HttpResponse:
    try:
        payload = req.get_json()
    except ValueError:
        return _json_response({"error": "Request body must be JSON."}, 400)

    file_name = payload.get("fileName") or "document.pdf"
    file_base64 = payload.get("fileBase64")
    if not file_base64:
        return _json_response({"error": "fileBase64 is required."}, 400)

    try:
        file_bytes = base64.b64decode(file_base64, validate=True)
    except ValueError:
        return _json_response({"error": "fileBase64 is not valid base64."}, 400)

    suffix = Path(file_name).suffix or ".pdf"
    try:
        with tempfile.TemporaryDirectory(prefix="xtract-docling-") as temp_dir:
            input_path = Path(temp_dir) / f"input{suffix}"
            input_path.write_bytes(file_bytes)

            result = converter.convert(str(input_path))
            markdown = result.document.export_to_markdown()

        return _json_response({
            "engine": "docling",
            "fileName": file_name,
            "markdown": markdown,
        })
    except Exception as exc:
        logging.exception("Docling markdown extraction failed")
        return _json_response({"error": f"Docling markdown extraction failed: {exc}"}, 500)
