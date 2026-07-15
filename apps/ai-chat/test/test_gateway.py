import base64
import importlib.util
import http.client
import json
import os
import pathlib
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parents[3]
APP_DIR = ROOT / "apps" / "ai-chat"


def load_server_module():
    spec = importlib.util.spec_from_file_location("ai_chat_server", APP_DIR / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeUpstream(BaseHTTPRequestHandler):
    seen_authorization = ""
    seen_payload = {}
    seen_payloads = []
    planner_response = {"should_search": True, "query": "planned cz status", "reason": "needs current context"}
    relevance_responses = [{"relevant": True, "query": "", "reason": "results match"}]

    def log_message(self, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        FakeUpstream.seen_authorization = self.headers.get("authorization", "")
        FakeUpstream.seen_payload = json.loads(self.rfile.read(length) or b"{}")
        FakeUpstream.seen_payloads.append(FakeUpstream.seen_payload)
        messages = FakeUpstream.seen_payload.get("messages") or []
        is_search_planner = any(
            "联网搜索规划器" in str(message.get("content") or "")
            for message in messages
            if message.get("role") == "system"
        )
        is_relevance_checker = any(
            "联网搜索结果相关性检查器" in str(message.get("content") or "")
            for message in messages
            if message.get("role") == "system"
        )
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        if is_relevance_checker:
            response = FakeUpstream.relevance_responses.pop(0) if FakeUpstream.relevance_responses else {
                "relevant": True,
                "query": "",
                "reason": "results match",
            }
            self.wfile.write(
                json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": json.dumps(response, ensure_ascii=False),
                                }
                            }
                        ]
                    }
                ).encode()
            )
            return
        if is_search_planner:
            self.wfile.write(
                json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": json.dumps(FakeUpstream.planner_response, ensure_ascii=False),
                                }
                            }
                        ]
                    }
                ).encode()
            )
            return
        self.wfile.write(
            json.dumps(
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "mock answer",
                                "reasoning_content": "mock thinking",
                            }
                        }
                    ]
                }
            ).encode()
        )


class FakeSearch(BaseHTTPRequestHandler):
    seen_path = ""
    seen_paths = []

    def log_message(self, *_args):
        return

    def do_GET(self):
        FakeSearch.seen_path = self.path
        FakeSearch.seen_paths.append(self.path)
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps(
                {
                    "results": [
                        {
                            "title": "CZ search result",
                            "url": "https://example.test/cz",
                            "snippet": "search context from provider",
                        }
                    ]
                }
            ).encode()
        )


class FakeMediaUpstream(BaseHTTPRequestHandler):
    seen_authorization = ""
    seen_path = ""
    seen_payload = {}

    def log_message(self, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        FakeMediaUpstream.seen_authorization = self.headers.get("authorization", "")
        FakeMediaUpstream.seen_path = self.path
        FakeMediaUpstream.seen_payload = json.loads(self.rfile.read(length) or b"{}")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps(
                {
                    "status": "submitted",
                    "outputs": [
                        {
                            "type": FakeMediaUpstream.seen_payload.get("type", "image"),
                            "url": "https://example.test/generated.png",
                        }
                    ],
                }
            ).encode()
        )


class FakeComfyUI(BaseHTTPRequestHandler):
    seen_prompt = {}
    history_payload = None
    upload_count = 0
    png_bytes = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    )
    mp4_bytes = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"

    def log_message(self, *_args):
        return

    def do_POST(self):
        if self.path == "/prompt":
            length = int(self.headers.get("content-length", "0"))
            FakeComfyUI.seen_prompt = json.loads(self.rfile.read(length) or b"{}")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"prompt_id": "fake-prompt-id"}).encode())
            return

        if self.path == "/upload/image":
            FakeComfyUI.upload_count += 1
            self.rfile.read(int(self.headers.get("content-length", "0")))
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"name": "uploaded-input.png", "subfolder": "", "type": "input"}).encode())
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == "/history/fake-prompt-id":
            if FakeComfyUI.history_payload is not None:
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(FakeComfyUI.history_payload).encode())
                return

            prompt = FakeComfyUI.seen_prompt.get("prompt") or {}
            if any(node.get("class_type") == "SaveVideo" for node in prompt.values()):
                outputs = {
                    "11": {
                        "images": [
                            {
                                "filename": "generated.mp4",
                                "subfolder": "",
                                "type": "output",
                            }
                        ],
                        "animated": [True],
                    }
                }
            else:
                outputs = {
                    "9": {
                        "images": [
                            {
                                "filename": "generated.png",
                                "subfolder": "",
                                "type": "output",
                            }
                        ]
                    }
                }
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "fake-prompt-id": {
                            "outputs": outputs,
                        }
                    }
                ).encode()
            )
            return

        if self.path.startswith("/view?"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if query.get("filename") == ["generated.mp4"]:
                self.send_response(200)
                self.send_header("content-type", "video/mp4")
                self.end_headers()
                self.wfile.write(FakeComfyUI.mp4_bytes)
                return
            if query.get("filename") == ["generated.png"]:
                self.send_response(200)
                self.send_header("content-type", "image/png")
                self.end_headers()
                self.wfile.write(FakeComfyUI.png_bytes)
                return

        self.send_response(404)
        self.end_headers()


class AiChatGatewayTest(unittest.TestCase):
    def setUp(self):
        FakeUpstream.seen_authorization = ""
        FakeUpstream.seen_payload = {}
        FakeUpstream.seen_payloads = []
        FakeUpstream.planner_response = {
            "should_search": True,
            "query": "planned cz status",
            "reason": "needs current context",
        }
        FakeUpstream.relevance_responses = [{"relevant": True, "query": "", "reason": "results match"}]
        FakeSearch.seen_path = ""
        FakeSearch.seen_paths = []
        FakeMediaUpstream.seen_authorization = ""
        FakeMediaUpstream.seen_path = ""
        FakeMediaUpstream.seen_payload = {}
        FakeComfyUI.seen_prompt = {}
        FakeComfyUI.history_payload = None
        FakeComfyUI.upload_count = 0

    def test_config_defaults_to_public_web_port_without_exposing_secret(self):
        server = load_server_module()

        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": "http://127.0.0.1:18000",
            }
        )

        self.assertEqual(config.port, 9999)
        self.assertEqual(config.model, "qwen3.6-35b-a3b")
        self.assertIn("cn.bing.com", config.web_search_url)
        public_config = server.public_config(config)
        self.assertEqual(public_config["port"], 9999)
        self.assertEqual(public_config["apiKey"], "server-side")
        self.assertEqual(public_config["features"]["webSearch"], True)
        self.assertNotIn("secret-key", json.dumps(public_config))

    def test_static_serving_rejects_sibling_prefix_traversal(self):
        server = load_server_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = pathlib.Path(tmpdir)
            public_dir = root / "public"
            sibling_dir = root / "public_evil"
            public_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.txt").write_text("leaked", encoding="utf-8")
            config = server.build_config(
                {
                    "AI_CHAT_API_KEY": "secret-key",
                    "AI_CHAT_PUBLIC_DIR": str(public_dir),
                }
            )
            app = server.AiChatServer(("127.0.0.1", 0), server.AiChatHandler, config)
            thread = threading.Thread(target=app.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(app.shutdown)
            self.addCleanup(app.server_close)
            self.addCleanup(thread.join, 2)

            connection = http.client.HTTPConnection("127.0.0.1", app.server_port, timeout=2)
            self.addCleanup(connection.close)
            connection.request("GET", "/../public_evil/secret.txt")
            response = connection.getresponse()
            body = response.read().decode("utf-8", errors="ignore")

            self.assertEqual(response.status, 404)
            self.assertNotIn("leaked", body)

    def test_search_config_can_be_disabled_without_exposing_provider_url(self):
        server = load_server_module()

        disabled = server.build_config({"AI_CHAT_API_KEY": "secret-key", "AI_CHAT_WEB_SEARCH_ENABLED": "0"})
        enabled = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": "http://127.0.0.1:18081/search?q={query}",
                "AI_CHAT_WEB_SEARCH_FALLBACK_URLS": "https://example.test/rss, https://example.test/markets.xml",
            }
        )

        self.assertFalse(server.public_config(disabled)["features"]["webSearch"])
        self.assertTrue(server.public_config(enabled)["features"]["webSearch"])
        self.assertEqual(
            enabled.web_search_fallback_urls,
            ["https://example.test/rss", "https://example.test/markets.xml"],
        )
        self.assertNotIn("AI_CHAT_WEB_SEARCH_URL", json.dumps(server.public_config(enabled)))

    def test_media_config_exposes_proxy_paths_without_upstream_urls(self):
        server = load_server_module()

        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_IMAGE_GENERATION_URL": "http://127.0.0.1:18188/private-image",
                "AI_CHAT_VIDEO_GENERATION_URL": "http://127.0.0.1:18189/private-video",
                "AI_CHAT_MEDIA_API_KEY": "media-secret",
            }
        )

        public_config = server.public_config(config)

        self.assertTrue(public_config["features"]["imageGeneration"])
        self.assertTrue(public_config["features"]["videoGeneration"])
        self.assertEqual(public_config["media"]["imagePath"], "/api/media/image")
        self.assertEqual(public_config["media"]["videoPath"], "/api/media/video")
        self.assertNotIn("18188", json.dumps(public_config))
        self.assertNotIn("media-secret", json.dumps(public_config))

    def test_media_forms_expose_advanced_parameters(self):
        html = (APP_DIR / "public" / "index.html").read_text(encoding="utf-8")
        script = (APP_DIR / "public" / "app.js").read_text(encoding="utf-8")

        for control_id in [
            "image-negative-prompt",
            "image-width",
            "image-height",
            "image-steps",
            "image-cfg",
            "image-seed",
            "image-sampler",
            "video-negative-prompt",
            "video-width",
            "video-height",
            "video-length",
            "video-steps",
            "video-cfg",
            "video-fps",
            "video-seed",
            "video-quality-profile",
        ]:
            self.assertIn(f'id="{control_id}"', html)

        self.assertIn("function collectImageOptions", script)
        self.assertIn("function collectVideoOptions", script)

    def test_quality_defaults_can_be_configured_for_comfyui_models(self):
        server = load_server_module()

        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_IMAGE_GENERATION_URL": "http://127.0.0.1:18188",
                "AI_CHAT_IMAGE_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_IMAGE_CHECKPOINT": "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors",
                "AI_CHAT_IMAGE_SAMPLER": "dpmpp_2m_sde",
                "AI_CHAT_IMAGE_SCHEDULER": "karras",
                "AI_CHAT_VIDEO_MODEL_PROFILE": "wan22-14b-lightx2v",
            }
        )
        image_workflow = server.build_comfyui_image_workflow(
            {"mode": "text-to-image", "prompt": "cinematic robot"},
            checkpoint=config.image_checkpoint,
            sampler=config.image_sampler,
            scheduler=config.image_scheduler,
        )
        video_workflow = server.build_comfyui_video_workflow(
            {"mode": "text-to-video", "prompt": "cinematic robot walking"},
            config.video_model_profile,
        )

        self.assertEqual(image_workflow["4"]["inputs"]["ckpt_name"], "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors")
        self.assertEqual(image_workflow["3"]["inputs"]["sampler_name"], "dpmpp_2m_sde")
        self.assertEqual(image_workflow["3"]["inputs"]["scheduler"], "karras")
        self.assertEqual(video_workflow["1"]["inputs"]["unet_name"], "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors")
        self.assertEqual(video_workflow["2"]["inputs"]["unet_name"], "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors")
        self.assertEqual(video_workflow["3"]["inputs"]["lora_name"], "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors")
        self.assertEqual(video_workflow["4"]["inputs"]["lora_name"], "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors")
        self.assertEqual(video_workflow["12"]["class_type"], "KSamplerAdvanced")

    def test_media_generation_proxy_forwards_payload_with_server_key(self):
        media = ThreadingHTTPServer(("127.0.0.1", 0), FakeMediaUpstream)
        thread = threading.Thread(target=media.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(media.shutdown)
        self.addCleanup(media.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_IMAGE_GENERATION_URL": f"http://127.0.0.1:{media.server_port}/image/jobs",
                "AI_CHAT_MEDIA_API_KEY": "media-secret",
            }
        )

        status, headers, body = server.call_media_generation(
            config,
            "image",
            {
                "mode": "image-to-image",
                "prompt": "make it warmer",
                "image": "data:image/png;base64,abc",
            },
        )

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(FakeMediaUpstream.seen_path, "/image/jobs")
        self.assertEqual(FakeMediaUpstream.seen_authorization, "Bearer media-secret")
        self.assertEqual(FakeMediaUpstream.seen_payload["type"], "image")
        self.assertEqual(FakeMediaUpstream.seen_payload["mode"], "image-to-image")
        self.assertEqual(json.loads(body)["outputs"][0]["url"], "https://example.test/generated.png")

    def test_comfyui_text_to_image_generates_renderable_data_url(self):
        comfy = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyUI)
        thread = threading.Thread(target=comfy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(comfy.shutdown)
        self.addCleanup(comfy.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_IMAGE_GENERATION_URL": f"http://127.0.0.1:{comfy.server_port}",
                "AI_CHAT_IMAGE_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_MEDIA_TIMEOUT_SECONDS": "1",
            }
        )

        status, headers, body = server.call_media_generation(
            config,
            "image",
            {"mode": "text-to-image", "prompt": "a white robot in a clean showroom", "width": 512, "height": 512},
        )

        data = json.loads(body)
        prompt = FakeComfyUI.seen_prompt["prompt"]

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["backend"], "comfyui")
        self.assertTrue(data["outputs"][0]["dataUrl"].startswith("data:image/png;base64,"))
        self.assertEqual(prompt["4"]["inputs"]["ckpt_name"], "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors")
        self.assertEqual(prompt["6"]["inputs"]["text"], "a white robot in a clean showroom")
        self.assertEqual(prompt["5"]["class_type"], "EmptyLatentImage")

    def test_comfyui_prompt_failure_returns_without_waiting_for_timeout(self):
        FakeComfyUI.history_payload = {
            "fake-prompt-id": {
                "status": {
                    "completed": True,
                    "status_str": "error",
                    "messages": [["execution_error", {"exception_message": "bad checkpoint"}]],
                },
                "outputs": {},
            }
        }
        comfy = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyUI)
        thread = threading.Thread(target=comfy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(comfy.shutdown)
        self.addCleanup(comfy.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_IMAGE_GENERATION_URL": f"http://127.0.0.1:{comfy.server_port}",
                "AI_CHAT_IMAGE_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_MEDIA_TIMEOUT_SECONDS": "30",
            }
        )

        with self.assertRaisesRegex(ValueError, "bad checkpoint"):
            server.comfyui_image_generation(
                config,
                config.image_generation_url,
                {"mode": "text-to-image", "prompt": "a white robot"},
            )

    def test_comfyui_image_to_image_uploads_source_image(self):
        comfy = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyUI)
        thread = threading.Thread(target=comfy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(comfy.shutdown)
        self.addCleanup(comfy.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_IMAGE_GENERATION_URL": f"http://127.0.0.1:{comfy.server_port}",
                "AI_CHAT_IMAGE_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_MEDIA_TIMEOUT_SECONDS": "1",
            }
        )

        status, _headers, body = server.call_media_generation(
            config,
            "image",
            {
                "mode": "image-to-image",
                "prompt": "make the lighting warmer",
                "image": "data:image/png;base64," + base64.b64encode(FakeComfyUI.png_bytes).decode(),
            },
        )

        prompt = FakeComfyUI.seen_prompt["prompt"]

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "completed")
        self.assertEqual(FakeComfyUI.upload_count, 1)
        self.assertEqual(prompt["10"]["class_type"], "LoadImage")
        self.assertEqual(prompt["10"]["inputs"]["image"], "uploaded-input.png")
        self.assertEqual(prompt["11"]["class_type"], "VAEEncode")
        self.assertEqual(prompt["3"]["inputs"]["latent_image"], ["11", 0])

    def test_comfyui_text_to_video_generates_renderable_data_url(self):
        comfy = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyUI)
        thread = threading.Thread(target=comfy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(comfy.shutdown)
        self.addCleanup(comfy.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_VIDEO_GENERATION_URL": f"http://127.0.0.1:{comfy.server_port}",
                "AI_CHAT_VIDEO_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_VIDEO_MODEL_PROFILE": "wan22-5b-ti2v",
                "AI_CHAT_MEDIA_TIMEOUT_SECONDS": "1",
            }
        )

        status, headers, body = server.call_media_generation(
            config,
            "video",
            {"mode": "text-to-video", "prompt": "a small robot waves", "width": 128, "height": 128, "length": 1},
        )

        data = json.loads(body)
        prompt = FakeComfyUI.seen_prompt["prompt"]

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["backend"], "comfyui")
        self.assertEqual(data["mode"], "text-to-video")
        self.assertTrue(data["outputs"][0]["dataUrl"].startswith("data:video/mp4;base64,"))
        self.assertEqual(prompt["1"]["inputs"]["unet_name"], "wan2.2_ti2v_5B_fp16.safetensors")
        self.assertEqual(prompt["6"]["class_type"], "Wan22ImageToVideoLatent")
        self.assertEqual(prompt["11"]["class_type"], "SaveVideo")

    def test_comfyui_image_to_video_uploads_source_image(self):
        comfy = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyUI)
        thread = threading.Thread(target=comfy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(comfy.shutdown)
        self.addCleanup(comfy.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_VIDEO_GENERATION_URL": f"http://127.0.0.1:{comfy.server_port}",
                "AI_CHAT_VIDEO_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_VIDEO_MODEL_PROFILE": "wan22-5b-ti2v",
                "AI_CHAT_MEDIA_TIMEOUT_SECONDS": "1",
            }
        )

        status, _headers, body = server.call_media_generation(
            config,
            "video",
            {
                "mode": "image-to-video",
                "prompt": "make it gently move",
                "image": "data:image/png;base64," + base64.b64encode(FakeComfyUI.png_bytes).decode(),
                "length": 1,
            },
        )

        prompt = FakeComfyUI.seen_prompt["prompt"]

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "completed")
        self.assertEqual(FakeComfyUI.upload_count, 1)
        self.assertEqual(prompt["12"]["class_type"], "LoadImage")
        self.assertEqual(prompt["6"]["inputs"]["start_image"], ["12", 0])

    def test_comfyui_keyframes_to_video_uses_first_and_last_frames(self):
        comfy = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyUI)
        thread = threading.Thread(target=comfy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(comfy.shutdown)
        self.addCleanup(comfy.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_VIDEO_GENERATION_URL": f"http://127.0.0.1:{comfy.server_port}",
                "AI_CHAT_VIDEO_GENERATION_BACKEND": "comfyui",
                "AI_CHAT_VIDEO_MODEL_PROFILE": "wan22-5b-ti2v",
                "AI_CHAT_MEDIA_TIMEOUT_SECONDS": "1",
            }
        )

        keyframe = "data:image/png;base64," + base64.b64encode(FakeComfyUI.png_bytes).decode()
        status, _headers, body = server.call_media_generation(
            config,
            "video",
            {
                "mode": "keyframes-to-video",
                "prompt": "move from first frame to last frame",
                "keyframes": [{"name": "first.png", "dataUrl": keyframe}, {"name": "last.png", "dataUrl": keyframe}],
                "length": 1,
            },
        )

        prompt = FakeComfyUI.seen_prompt["prompt"]

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "completed")
        self.assertEqual(FakeComfyUI.upload_count, 2)
        self.assertEqual(prompt["6"]["class_type"], "WanFirstLastFrameToVideo")
        self.assertEqual(prompt["6"]["inputs"]["start_image"], ["12", 0])
        self.assertEqual(prompt["6"]["inputs"]["end_image"], ["13", 0])

    def test_chat_proxy_injects_server_key_and_thinking_mode(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
            }
        )

        status, headers, body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": False,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(json.loads(body)["choices"][0]["message"]["content"], "mock answer")
        self.assertEqual(FakeUpstream.seen_authorization, "Bearer secret-key")
        self.assertEqual(FakeUpstream.seen_payload["model"], "qwen3.6-35b-a3b")
        self.assertFalse(FakeUpstream.seen_payload["stream"])
        self.assertEqual(FakeUpstream.seen_payload["chat_template_kwargs"], {"enable_thinking": False})

    def test_chat_proxy_adds_llm_planned_search_context_when_enabled_per_request(self):
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/search?q={{query}}",
                "AI_CHAT_WEB_SEARCH_FALLBACK_URLS": "",
            }
        )

        status, _headers, _body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "latest cz status"}],
                "web_search": True,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        self.assertIn("planned+cz+status", FakeSearch.seen_path)
        self.assertEqual(len(FakeUpstream.seen_payloads), 3)
        planner_payload = FakeUpstream.seen_payloads[0]
        relevance_payload = FakeUpstream.seen_payloads[1]
        self.assertFalse(planner_payload["stream"])
        self.assertEqual(planner_payload["chat_template_kwargs"], {"enable_thinking": False})
        self.assertLessEqual(planner_payload["max_tokens"], 96)
        self.assertIn("快速判断", planner_payload["messages"][0]["content"])
        self.assertFalse(relevance_payload["stream"])
        self.assertEqual(relevance_payload["chat_template_kwargs"], {"enable_thinking": False})
        self.assertLessEqual(relevance_payload["max_tokens"], 96)
        self.assertIn("相关性检查器", relevance_payload["messages"][0]["content"])
        first_message = FakeUpstream.seen_payload["messages"][0]
        self.assertEqual(first_message["role"], "system")
        self.assertIn("联网搜索结果", first_message["content"])
        self.assertIn("搜索问题：planned cz status", first_message["content"])
        self.assertIn("CZ search result", first_message["content"])
        self.assertNotIn("web_search", FakeUpstream.seen_payload)

    def test_web_search_answer_preserves_main_thinking_when_ui_thinking_is_enabled(self):
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/search?q={{query}}",
                "AI_CHAT_WEB_SEARCH_FALLBACK_URLS": "",
            }
        )

        status, _headers, _body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "给我讲讲近期 ai harness engineering"}],
                "thinking": True,
                "web_search": True,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        self.assertEqual(len(FakeUpstream.seen_payloads), 3)
        planner_payload = FakeUpstream.seen_payloads[0]
        answer_payload = FakeUpstream.seen_payloads[2]
        self.assertEqual(planner_payload["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(answer_payload["chat_template_kwargs"], {"enable_thinking": True})
        self.assertIn("联网搜索结果", answer_payload["messages"][0]["content"])

    def test_web_search_retries_with_llm_query_when_results_are_not_relevant(self):
        FakeUpstream.planner_response = {
            "should_search": True,
            "query": "today hot news",
            "reason": "needs current context",
        }
        FakeUpstream.relevance_responses = [
            {
                "relevant": False,
                "query": "international finance news Reuters Bloomberg markets today",
                "reason": "results are domestic social news",
            },
            {"relevant": True, "query": "", "reason": "results match finance topic"},
        ]
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/search?q={{query}}",
            }
        )

        status, _headers, _body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "给我讲讲今天热门国际财经新闻"}],
                "web_search": True,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        self.assertEqual(len(FakeSearch.seen_paths), 2)
        self.assertIn("today+hot+news", FakeSearch.seen_paths[0])
        self.assertIn("international+finance+news+Reuters+Bloomberg+markets+today", FakeSearch.seen_paths[1])
        first_message = FakeUpstream.seen_payload["messages"][0]
        self.assertIn("搜索问题：international finance news Reuters Bloomberg markets today", first_message["content"])

    def test_irrelevant_search_results_are_not_injected_into_answer_context(self):
        FakeUpstream.planner_response = {
            "should_search": True,
            "query": "CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg",
            "reason": "needs finance news",
        }
        FakeUpstream.relevance_responses = [
            {
                "relevant": False,
                "query": "CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg",
                "reason": "results are unrelated app downloads",
            },
        ]
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/search?q={{query}}",
                "AI_CHAT_WEB_SEARCH_FALLBACK_URLS": "",
            }
        )

        status, _headers, _body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "给我一点今天的热门财经新闻"}],
                "web_search": True,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        first_message = FakeUpstream.seen_payload["messages"][0]
        self.assertIn("搜索结果与用户问题不相关", first_message["content"])
        self.assertIn("无法从搜索结果确认", first_message["content"])
        self.assertNotIn("CZ search result", first_message["content"])

    def test_web_search_uses_fallback_provider_when_primary_results_are_irrelevant(self):
        FakeUpstream.planner_response = {
            "should_search": True,
            "query": "CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg",
            "reason": "needs finance news",
        }
        FakeUpstream.relevance_responses = [
            {
                "relevant": False,
                "query": "CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg",
                "reason": "primary results are unrelated",
            },
            {"relevant": True, "query": "", "reason": "fallback results match finance topic"},
        ]
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/primary?q={{query}}",
                "AI_CHAT_WEB_SEARCH_FALLBACK_URLS": f"http://127.0.0.1:{search.server_port}/fallback?q={{query}}",
            }
        )

        status, _headers, _body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "给我一点今天的热门财经新闻"}],
                "web_search": True,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        self.assertIn("/primary", FakeSearch.seen_paths[0])
        self.assertIn("/fallback", FakeSearch.seen_paths[1])
        first_message = FakeUpstream.seen_payload["messages"][0]
        self.assertIn("联网搜索结果", first_message["content"])
        self.assertIn("CZ search result", first_message["content"])

    def test_web_search_planner_can_skip_search_when_not_needed(self):
        FakeUpstream.planner_response = {
            "should_search": False,
            "query": "",
            "reason": "answerable without current web data",
        }
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_LLM_BASE_URL": f"http://127.0.0.1:{upstream.server_port}",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/search?q={{query}}",
            }
        )

        status, _headers, _body = server.call_chat_completion(
            config,
            {
                "messages": [{"role": "user", "content": "给我讲一个短笑话"}],
                "web_search": True,
                "stream": False,
            },
        )

        self.assertEqual(status, 200)
        self.assertEqual(FakeSearch.seen_path, "")
        self.assertEqual(len(FakeUpstream.seen_payloads), 2)
        first_message = FakeUpstream.seen_payload["messages"][0]
        self.assertNotIn("联网搜索结果", first_message["content"])

    def test_planner_prompt_steers_broad_news_queries_to_news_sources(self):
        server = load_server_module()

        self.assertIn("今日要闻", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("央视新闻", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("新华社", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("不要搜索日历", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("热门财经", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("财经新闻", server.WEB_SEARCH_RELEVANCE_PROMPT)
        self.assertIn("CNBC markets latest financial news stocks oil dollar today", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("LangGraph AutoGen CrewAI OpenAI Swarm GitHub latest orchestration", server.WEB_SEARCH_PLANNER_PROMPT)
        self.assertIn("CNBC markets latest financial news stocks oil dollar today", server.WEB_SEARCH_RELEVANCE_PROMPT)
        self.assertIn("LangGraph AutoGen CrewAI OpenAI Swarm GitHub latest orchestration", server.WEB_SEARCH_RELEVANCE_PROMPT)

    def test_debug_search_script_exposes_planning_relevance_and_retry_details(self):
        debug_script = (APP_DIR / "debug_search.py").read_text(encoding="utf-8")

        required_markers = [
            "argparse",
            "plan_web_search",
            "fetch_web_search_results",
            "judge_web_search_relevance",
            "INITIAL_QUERY",
            "INITIAL_RESULTS",
            "RELEVANCE",
            "RETRY_QUERY",
            "FINAL_QUERY",
            "FINAL_RESULTS",
            "--json",
        ]
        for marker in required_markers:
            self.assertIn(marker, debug_script)

    def test_current_datetime_context_uses_configured_clock_and_weekday(self):
        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_NOW_ISO": "2026-06-25T08:30:00-07:00",
            }
        )

        context = server.current_datetime_context(config)

        self.assertIn("2026年06月25日", context)
        self.assertIn("星期四", context)
        self.assertIn("不要从网页搜索结果推断", context)
        self.assertIn("不要输出内部推理过程", context)

    def test_current_date_questions_skip_web_search_even_when_toggle_is_enabled(self):
        FakeSearch.seen_path = ""
        search = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        search_thread = threading.Thread(target=search.serve_forever, daemon=True)
        search_thread.start()
        self.addCleanup(search.shutdown)
        self.addCleanup(search.server_close)
        self.addCleanup(search_thread.join, 2)

        server = load_server_module()
        config = server.build_config(
            {
                "AI_CHAT_API_KEY": "secret-key",
                "AI_CHAT_WEB_SEARCH_ENABLED": "1",
                "AI_CHAT_WEB_SEARCH_URL": f"http://127.0.0.1:{search.server_port}/search?q={{query}}",
                "AI_CHAT_NOW_ISO": "2026-06-25T08:30:00-07:00",
            }
        )

        payload = server.prepare_upstream_payload(
            config,
            {
                "messages": [{"role": "user", "content": "帮我搜索一下今天是周几"}],
                "thinking": True,
                "web_search": True,
                "stream": False,
            },
            False,
        )

        self.assertEqual(FakeSearch.seen_path, "")
        first_message = payload["messages"][0]
        self.assertEqual(first_message["role"], "system")
        self.assertIn("当前服务端时间", first_message["content"])
        self.assertIn("星期四", first_message["content"])
        self.assertNotIn("联网搜索结果", first_message["content"])
        self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": False})

    def test_html_search_results_are_normalized_for_bing_style_pages(self):
        server = load_server_module()
        html = """
        <html><body>
          <li class="b_algo">
            <h2><a href="https://example.test/a">Result A</a></h2>
            <p>Snippet A from html.</p>
          </li>
        </body></html>
        """

        results = server.normalize_html_search_results(html, 3)

        self.assertEqual(results[0]["title"], "Result A")
        self.assertEqual(results[0]["url"], "https://example.test/a")
        self.assertEqual(results[0]["snippet"], "Snippet A from html.")

    def test_rss_search_results_are_normalized_for_finance_feeds(self):
        server = load_server_module()
        rss = """
        <?xml version="1.0" encoding="UTF-8"?>
        <rss><channel>
          <item>
            <title>Markets rise as oil falls</title>
            <link>https://example.test/markets-rise</link>
            <description>Stocks gained while crude moved lower.</description>
          </item>
        </channel></rss>
        """

        results = server.normalize_xml_search_results(rss, 3)

        self.assertEqual(results[0]["title"], "Markets rise as oil falls")
        self.assertEqual(results[0]["url"], "https://example.test/markets-rise")
        self.assertEqual(results[0]["snippet"], "Stocks gained while crude moved lower.")

    def test_web_search_query_strips_common_instruction_words(self):
        server = load_server_module()

        query = server.web_search_query_from_messages(
            [{"role": "user", "content": "请结合联网搜索, 用一句中文说明 Qwen 是什么。"}]
        )
        date_query = server.web_search_query_from_messages(
            [{"role": "user", "content": "帮我搜索一下今天是周几"}]
        )

        self.assertEqual(query, "Qwen 是什么")
        self.assertEqual(date_query, "今天是周几")

    def test_static_ui_contains_required_chatgpt_like_features(self):
        app_js = (APP_DIR / "public" / "app.js").read_text(encoding="utf-8")
        index_html = (APP_DIR / "public" / "index.html").read_text(encoding="utf-8")
        styles_css = (APP_DIR / "public" / "styles.css").read_text(encoding="utf-8")

        required_markers = [
            "localStorage",
            "compressConversation",
            "renderConversationList",
            "toggle-thinking",
            "getReader",
            "reasoning_content",
            "scheduleMessageRender",
            "requestAnimationFrame",
            "details class=\"thinking-block\"",
            "elapsedMs",
            "formatDuration",
            "toggle-web-search",
            "renderMarkdown",
            "markdown-body",
            "activeRequests = new Map",
            "activeRequests.has(conversation.id)",
            "activeRequests.set(conversation.id",
            "activeRequests.delete(conversation.id",
            'rel="icon"',
            "deleteConversation",
            "exportConversation",
            "copy-code-button",
            "copyCodeBlock",
            "navigator.clipboard.writeText",
            "document.execCommand(\"copy\")",
            "data-code",
            "feedback-button",
            "setMessageFeedback",
            "feedbackUpdatedAt",
            "MEDIA_HISTORY_KEY",
            "media-panel",
            "生图",
            "文生图",
            "图生图",
            "持续改图",
            "生视频",
            "文生视频",
            "图生视频",
            "关键帧",
            "/api/media/image",
            "/api/media/video",
        ]
        for marker in required_markers:
            self.assertIn(marker, app_js + index_html + styles_css)
        self.assertIn(".copy-code-button", styles_css)
        self.assertIn("position: absolute", styles_css)
        self.assertNotIn('escapeHtml(message.content || (message.streaming ? "正在生成..." : ""))', app_js)

    def test_deployment_scripts_expose_ai_chat_web_on_9999(self):
        setup_frps = (ROOT / "scripts" / "cloud" / "setup-frps.sh").read_text(encoding="utf-8")
        setup_frpc = (ROOT / "scripts" / "windows" / "setup-frpc.ps1").read_text(encoding="utf-8")
        setup_web = (ROOT / "scripts" / "ai-stack" / "setup-ai-chat-web.sh").read_text(encoding="utf-8")

        self.assertIn("2222,2444,9000,9999", setup_frps)
        self.assertIn("$AiChatWebRemotePort = 9999", setup_frpc)
        self.assertIn("$AiChatWebLocalPort = 9999", setup_frpc)
        self.assertIn("ai-chat-web-$AiChatWebRemotePort", setup_frpc)
        self.assertIn('AI_CHAT_PORT="${AI_CHAT_PORT:-9999}"', setup_web)
        self.assertIn("AI_CHAT_PORT=$AI_CHAT_PORT", setup_web)
        self.assertIn("AI_CHAT_WEB_SEARCH_ENABLED", setup_web)
        self.assertIn("AI_CHAT_WEB_SEARCH_FALLBACK_URLS", setup_web)
        self.assertIn("AI_CHAT_IMAGE_GENERATION_URL", setup_web)
        self.assertIn("AI_CHAT_VIDEO_GENERATION_URL", setup_web)
        self.assertIn("AI_CHAT_MEDIA_API_KEY", setup_web)
        self.assertIn("debug_search.py", setup_web)
        self.assertIn("systemctl restart ai-chat-web.service", setup_web)
        self.assertIn("ai-chat-web.service", setup_web)


if __name__ == "__main__":
    unittest.main()
