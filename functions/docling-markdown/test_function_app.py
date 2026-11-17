import importlib.util
import logging
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class HttpResponse:
    def __init__(self, body, status_code, mimetype):
        self.body = body
        self.status_code = status_code


class FunctionApp:
    def __init__(self, **kwargs):
        pass

    def route(self, **kwargs):
        return lambda function: function


azure = types.ModuleType("azure")
functions = types.ModuleType("azure.functions")
functions.AuthLevel = types.SimpleNamespace(FUNCTION="function")
functions.FunctionApp = FunctionApp
functions.HttpRequest = object
functions.HttpResponse = HttpResponse
docling = types.ModuleType("docling")
converter_module = types.ModuleType("docling.document_converter")
converter_module.DocumentConverter = lambda: None

with patch.dict(sys.modules, {
    "azure": azure,
    "azure.functions": functions,
    "docling": docling,
    "docling.document_converter": converter_module,
}):
    spec = importlib.util.spec_from_file_location("xtract_docling_test", Path(__file__).with_name("function_app.py"))
    function_app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(function_app)


class DoclingLoggingTests(unittest.TestCase):
    def test_document_id_correlates_success_logs_without_document_contents(self):
        document_id = "0123456789abcdef01234567"
        document = types.SimpleNamespace(
            export_to_markdown=lambda: "private document text",
            iterate_items=lambda: [],
        )
        function_app.converter = types.SimpleNamespace(convert=lambda path: types.SimpleNamespace(document=document))
        request = types.SimpleNamespace(get_json=lambda: {
            "documentId": document_id, "fileName": "private.pdf", "fileBase64": "c2VjcmV0",
        })
        with self.assertLogs("xtract_docling_test", level=logging.INFO) as logs:
            response = function_app.extract_markdown(request)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(all(f"[correlationId={document_id}]" in entry for entry in logs.output))
        self.assertTrue(all("private" not in entry and "secret" not in entry for entry in logs.output))

    def test_invalid_or_missing_document_id_uses_invocation_fallback(self):
        request = types.SimpleNamespace(get_json=lambda: {"documentId": "secret\ninvalid"})
        with self.assertLogs("xtract_docling_test", level=logging.INFO) as logs:
            response = function_app.extract_markdown(request)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(all("[correlationId=invocation:" in entry for entry in logs.output))
        self.assertTrue(all("secret" not in entry for entry in logs.output))

    def test_failure_logs_correlation_and_location_without_exception_content(self):
        document_id = "0123456789abcdef01234567"

        def fail(_path):
            raise RuntimeError("private document text")

        function_app.converter = types.SimpleNamespace(convert=fail)
        request = types.SimpleNamespace(get_json=lambda: {
            "documentId": document_id, "fileBase64": "c2VjcmV0",
        })
        with self.assertLogs("xtract_docling_test", level=logging.INFO) as logs:
            response = function_app.extract_markdown(request)
        self.assertEqual(response.status_code, 500)
        self.assertTrue(all(f"[correlationId={document_id}]" in entry for entry in logs.output))
        self.assertTrue(any("errorType=RuntimeError" in entry and "location=" in entry for entry in logs.output))
        self.assertTrue(all("private document text" not in entry for entry in logs.output))


if __name__ == "__main__":
    unittest.main()
