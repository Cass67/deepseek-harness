from __future__ import annotations

import inspect
import json
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from deepseek_harness import (
    CommandExecutionResponse,
    CommandListResponse,
    DeepSeekHarness,
    HarnessClient,
    HarnessConfig,
    ModelCatalogReasoning,
    Notification,
    ProviderAuthEventNotification,
    ProviderAuthPromptNotification,
    SdkProtocolError,
    SessionHistoryResponse,
)
from pydantic import ValidationError


def test_high_level_sdk_runs_turn_and_collects_final_response(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    env_dump = tmp_path / "env.json"
    init_dump = tmp_path / "init.json"
    script.write_text(
        """
import base64
import json
import os
import sys

env_dump = os.environ["ENV_DUMP"]
json.dump({
    "DEEPSEEK_API_KEY": os.environ.get("DEEPSEEK_API_KEY"),
    "DEEPSEEK_BASE_URL": os.environ.get("DEEPSEEK_BASE_URL"),
    "DSH_CWD": os.environ.get("DSH_CWD"),
    "DSH_SESSION_ROOT": os.environ.get("DSH_SESSION_ROOT"),
    "DSH_CORDIS_CONFIG": os.environ.get("DSH_CORDIS_CONFIG"),
}, open(env_dump, "w"))

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        json.dump(msg.get("params"), open(os.environ["INIT_DUMP"], "w"))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "attachment/imageLimits":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "maxImageBytes": 1024,
            "maxImagesPerMessage": 4,
            "maxMessageImageBytes": 4096,
            "maxImagePixels": 1000000,
            "mediaTypes": ["image/png", "image/jpeg"],
        }}), flush=True)
    elif method == "attachment/saveImage":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "attachmentId": "fake:attachment-1",
            "mediaType": params["mediaType"],
            "bytes": len(base64.b64decode(params["data"], validate=True)),
            "width": 1,
            "height": 1,
            **({"name": params["name"]} if "name" in params else {}),
        }}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "assistant/message",
                    "data": {
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "hello from runtime"}],
                        },
                    },
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 1, "reason": {"kind": "completed"}},
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 2, "reason": {"kind": "max-tokens"}},
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.status",
            "params": {"sessionId": params["sessionId"], "status": "idle"},
        }), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        model="deepseek-v4-flash",
        max_tokens=4096,
        cwd=str(tmp_path),
        cordis=str(tmp_path / "cordis.yml"),
        session_root=str(tmp_path / "sessions"),
        launch_args_override=(sys.executable, str(script)),
        env={
            "ENV_DUMP": str(env_dump),
            "INIT_DUMP": str(init_dump),
            "DEEPSEEK_API_KEY": "env-key",
            "DEEPSEEK_BASE_URL": "http://127.0.0.1:4321",
        },
    ) as harness:
        limits = harness.image_limits()
        named_attachment = harness.save_image(b"png", "image/png", "pixel.png")
        unnamed_attachment = harness.save_image(b"x", "image/png")
        result = harness.run("say hello", session_id="main")

    assert limits.max_image_bytes == 1024
    assert named_attachment.attachment_id == "fake:attachment-1"
    assert named_attachment.bytes == 3
    assert named_attachment.name == "pixel.png"
    assert unnamed_attachment.name is None
    assert result.final_response == "hello from runtime"
    assert result.finish_reason == "max-tokens"
    assert result.events[-1]["type"] == "turn/end"
    dumped_env = json.loads(env_dump.read_text())
    assert dumped_env["DEEPSEEK_API_KEY"] == "env-key"
    assert dumped_env["DEEPSEEK_BASE_URL"] == "http://127.0.0.1:4321"
    assert dumped_env["DSH_CWD"] == str(tmp_path)
    assert dumped_env["DSH_SESSION_ROOT"] == str(tmp_path / "sessions")
    assert dumped_env["DSH_CORDIS_CONFIG"] == str(tmp_path / "cordis.yml")
    assert json.loads(init_dump.read_text()) == {
        "cwd": str(tmp_path),
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "maxTokens": 4096,
    }


def test_session_run_invokes_notification_callback_before_returning(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "main", "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "main", "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    seen: list[str] = []
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        session = harness.start_session("main")
        result = session.run(
            "spawn a helper",
            on_notification=lambda notification: seen.append(notification.method),
        )

    assert seen == ["session.event", "session.status", "subagent.started", "session.status"]
    assert result.finish_reason is None


def test_high_level_sdk_rejects_turn_end_without_reason_kind(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "turn/end", "data": {"turn": 1, "reason": {}}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        with pytest.raises(
            SdkProtocolError,
            match=r"turn/end event requires a string data\.reason\.kind",
        ):
            harness.run("reject malformed turn ending", session_id="main")


def test_relative_cwd_is_absolute_in_process_environment_and_wire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / "capture_cwd.py"
    capture = tmp_path / "cwd.json"
    script.write_text(
        """
import json
import os
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        json.dump({"process": os.getcwd(), "environment": os.environ.get("DSH_CWD"), "wire": msg["params"]["cwd"]}, open(os.environ["CAPTURE"], "w"))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )
    monkeypatch.chdir(tmp_path)

    with DeepSeekHarness(
        cwd=".",
        runtime_cwd=".",
        launch_args_override=(sys.executable, str(script)),
        env={"CAPTURE": str(capture)},
    ):
        pass

    expected = str(tmp_path.resolve())
    assert json.loads(capture.read_text()) == {
        "process": expected,
        "environment": expected,
        "wire": expected,
    }


def test_session_run_includes_subagent_finished_for_parent_session(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "main", "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "main", "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": "main", "childSessionId": "child", "status": "ok", "stopReason": "completed"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run("spawn a helper", session_id="main")

    assert [notification.method for notification in result.notifications] == [
        "session.event",
        "session.status",
        "subagent.started",
        "subagent.finished",
        "session.status",
    ]


def test_session_run_collects_nested_subagent_tree_without_polluting_root_events(
    tmp_path: Path,
) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        root = (msg.get("params") or {})["sessionId"]
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": root, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": root, "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": root, "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "child", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "child response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "child", "childSessionId": "grandchild"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "grandchild", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "grandchild response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": "child", "childSessionId": "grandchild", "status": "ok"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": root, "childSessionId": "child", "status": "ok"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": root, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "root response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": root, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    seen: list[str] = []
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run(
            "delegate recursively",
            session_id="main",
            on_notification=lambda notification: seen.append(notification.method),
        )
        assert harness.client._notifications.qsize() == 0

    assert result.final_response == "root response"
    assert [event["data"]["content"][0]["text"] for event in result.events if event["type"] == "assistant/message"] == ["root response"]
    assert [notification.method for notification in result.notifications] == [
        "session.event",
        "session.status",
        "subagent.started",
        "session.event",
        "subagent.started",
        "session.event",
        "subagent.finished",
        "subagent.finished",
        "session.event",
        "session.status",
    ]
    assert seen == [notification.method for notification in result.notifications]


def test_session_run_ignores_notifications_for_other_sessions(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "other", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "wrong session"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "other", "status": "idle"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "right session"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run("stay in your lane", session_id="main")

    assert result.final_response == "right session"
    assert [notification.payload.get("sessionId") for notification in result.notifications] == ["main"] * 4


def test_high_level_session_run_does_not_accumulate_global_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "ok"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(launch_args_override=(sys.executable, str(script)), cwd=str(tmp_path)) as harness:
        result = harness.run("one turn", session_id="main")
        assert harness.client._notifications.qsize() == 0


def test_session_run_waits_for_late_idle_without_replaying_stale_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys
import time

turn = 0
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        turn += 1
        params = msg.get("params") or {}
        session_id = params["sessionId"]
        message_id = f"message-{turn}"
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": message_id}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": message_id}}), flush=True)
        if turn == 1:
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "first"}]}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
        else:
            time.sleep(0.05)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "second"}]}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(launch_args_override=(sys.executable, str(script)), cwd=str(tmp_path)) as harness:
        first = harness.run("first turn", session_id="main")
        second = harness.run("second turn", session_id="main")

    assert first.final_response == "first"
    assert second.final_response == "second"
    assert [notification.payload.get("sessionId") for notification in second.notifications] == ["main"] * 4


def test_client_starts_subprocess_sends_requests_and_routes_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "llm/request", "params": {"requestId": "req-1", "sessionId": params["sessionId"], "model": "dsagent", "messages": []}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(launch_args_override=(sys.executable, str(script)))
    ) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        assert init.serverInfo.name == "fake-dsh"

        client.session_prompt("main", [{"type": "text", "text": "fix it"}])
        notification = client.next_notification()
        assert notification.method == "llm/request"
        assert notification.payload["requestId"] == "req-1"
    assert notification.payload["sessionId"] == "main"


def test_client_keeps_unmatched_notifications_available_globally_while_subscribed() -> None:
    client = HarnessClient()
    with client.subscribe_session_notifications("main"):
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "other", "event": {"type": "assistant/message"}},
        })

        assert client._notifications.qsize() == 1
        notification = client._notifications.get_nowait()
        assert not isinstance(notification, BaseException)
        assert notification.method == "session.event"
        assert notification.payload["sessionId"] == "other"


def test_session_subscription_keeps_descendant_relationships_across_subscriptions() -> None:
    client = HarnessClient()
    with client.subscribe_session_notifications("main") as first:
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "main", "childSessionId": "child"},
        })
        assert first.next().payload["childSessionId"] == "child"

    with client.subscribe_session_notifications("main") as second:
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "child", "childSessionId": "grandchild"},
        })
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "grandchild", "event": {"type": "assistant/message"}},
        })
        assert second.next().payload["childSessionId"] == "grandchild"
        assert second.next().payload["sessionId"] == "grandchild"

    assert client._notifications.qsize() == 0


def test_session_subscription_preserves_reused_child_ancestry_after_late_finish() -> None:
    client = HarnessClient()
    old_seen: list[Notification] = []
    new_seen: list[Notification] = []
    with (
        client.subscribe_session_notifications("old-parent") as old_subscription,
        client.subscribe_session_notifications("new-parent") as new_subscription,
    ):
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "old-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in old_seen] == ["subagent.started"]
        assert new_seen == []

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "new-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in new_seen] == ["subagent.started"]

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.finished",
            "params": {"parentSessionId": "old-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in old_seen] == [
            "subagent.started",
            "subagent.finished",
        ]
        assert [notification.method for notification in new_seen] == ["subagent.started"]

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "reused-child", "event": {"type": "assistant/message"}},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)

    assert [notification.method for notification in old_seen] == [
        "subagent.started",
        "subagent.finished",
    ]
    assert [notification.method for notification in new_seen] == [
        "subagent.started",
        "session.event",
    ]
    assert client._notifications.qsize() == 0


def test_client_contains_notification_filter_failure_to_its_subscription(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method in {"emit-first", "emit-second"}:
        print(json.dumps({"jsonrpc": "2.0", "method": "tick", "params": {"source": method}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    def broken_filter(_notification: object) -> bool:
        raise RuntimeError("bad notification filter")

    with HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script)))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        with (
            client.subscribe_notifications(broken_filter) as broken,
            client.subscribe_notifications(lambda notification: notification.method == "tick") as healthy,
        ):
            client.notify("emit-first")
            with pytest.raises(RuntimeError, match="bad notification filter"):
                broken.next()
            assert healthy.next().payload == {"source": "emit-first"}
            assert client._notifications.qsize() == 0

            client.session_prompt("main", [{"type": "text", "text": "reader still works"}])
            client.notify("emit-second")
            assert healthy.next().payload == {"source": "emit-second"}


def test_client_rejects_unaccepted_session_prompt_response(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"accepted": False}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script)))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        with pytest.raises(ValueError):
            client.session_prompt("main", [{"type": "text", "text": "fix it"}])


def test_client_routes_bridge_requests_and_sends_responses(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": "bridge-req-1", "method": "llm.request", "params": {"requestId": "req-1", "sessionId": "main", "model": "dsagent", "messages": []}}), flush=True)
    elif "id" in msg and "method" not in msg:
        print(json.dumps({"jsonrpc": "2.0", "method": "response/seen", "params": {"result": msg.get("result")}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(launch_args_override=(sys.executable, str(script)))
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")

        request = client.next_request()
        assert request.id == "bridge-req-1"
        assert request.method == "llm.request"
        assert request.payload["requestId"] == "req-1"

        client.respond(request.id, {"content_blocks": [{"type": "text", "text": "done"}]})
        notification = client.next_notification()
        assert notification.method == "response/seen"
        assert notification.payload["result"]["content_blocks"][0]["text"] == "done"


def test_client_ignores_non_json_stdout_lines(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

print("node warning: experimental loader", flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(launch_args_override=(sys.executable, str(script)))
    ) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        assert init.serverInfo.name == "fake-dsh"


def test_client_request_times_out_when_bridge_does_not_respond(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import sys
import time

print("bridge is still starting", file=sys.stderr, flush=True)
time.sleep(60)
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            request_timeout_seconds=0.1,
        )
    ) as client:
        start = time.monotonic()
        try:
            client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        except TimeoutError as exc:
            assert time.monotonic() - start < 2
            assert "bridge is still starting" in str(exc)
        else:
            raise AssertionError("initialize should time out")


def test_client_close_times_out_when_shutdown_does_not_respond(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import signal
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        time.sleep(60)
""".strip()
    )

    client = HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            shutdown_timeout_seconds=0.1,
        )
    )
    client.start()
    proc = client._proc
    assert proc is not None
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    start = time.monotonic()
    client.close()
    assert time.monotonic() - start < 2
    assert proc.poll() is not None
    assert client._proc is None


def test_initialize_failure_reaps_started_runtime(tmp_path: Path) -> None:
    script = tmp_path / "rejecting_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": "bad initialize"}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    client = HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script))))
    client.start()
    proc = client._proc
    assert proc is not None

    with pytest.raises(Exception, match="bad initialize"):
        client.initialize(provider="deepseek-official", cwd=".", model="dsagent")

    assert proc.wait(timeout=1) is not None
    assert client._proc is None


def test_public_signatures_omit_unsupported_wire_parameters() -> None:
    from deepseek_harness import DeepSeekHarnessConfig, Session

    assert "session_root" not in inspect.signature(HarnessClient.initialize).parameters
    assert "system_prompt" not in inspect.signature(HarnessClient.initialize).parameters
    assert "profile" not in inspect.signature(HarnessClient.session_prompt).parameters
    assert "profile" not in inspect.signature(DeepSeekHarness.run).parameters
    assert "profile" not in inspect.signature(Session.run).parameters
    assert "system_prompt" not in DeepSeekHarnessConfig.__dataclass_fields__
    assert "max_tokens" in DeepSeekHarnessConfig.__dataclass_fields__
    assert "max_tokens" in inspect.signature(HarnessClient.initialize).parameters
    assert "client_name" not in HarnessConfig.__dataclass_fields__
    assert "client_version" not in HarnessConfig.__dataclass_fields__


def test_client_close_is_idempotent_before_and_after_start(tmp_path: Path) -> None:
    HarnessClient().close()

    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    client = HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script))))
    client.start()
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    client.close()
    client.close()


def test_runtime_closed_error_includes_stderr_tail(tmp_path: Path) -> None:
    script = tmp_path / "crashing_runtime.py"
    script.write_text(
        """
import sys

print("fatal bridge exploded", file=sys.stderr, flush=True)
sys.exit(42)
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            request_timeout_seconds=2,
        )
    ) as client:
        with pytest.raises(Exception, match="fatal bridge exploded"):
            client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")


def test_client_serializes_concurrent_writes(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    output = tmp_path / "seen.jsonl"
    script.write_text(
        """
import json
import os
import sys

with open(os.environ["SEEN"], "w") as seen:
    for line in sys.stdin:
        seen.write(line)
        seen.flush()
        msg = json.loads(line)
        if "id" in msg and msg.get("method") == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
        elif "id" in msg and msg.get("method") == "shutdown":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
            break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            env={"SEEN": str(output)},
        )
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        threads = [
            threading.Thread(target=client.notify, args=(f"notice-{index}", {"index": index}))
            for index in range(50)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    for line in output.read_text().splitlines():
        json.loads(line)


def _install_fake_bundled_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Install a fake runtime package that records config and serves lifecycle calls.

    Returns the fake bundled default config path.
    """
    runtime = tmp_path / "dsh-jsonrpc-agent"
    runtime.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys

json.dump({"DSH_CORDIS_CONFIG": os.environ.get("DSH_CORDIS_CONFIG")}, open(os.environ["ENV_DUMP"], "w"))
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "bundled-runtime"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )
    runtime.chmod(0o755)

    default_config = tmp_path / "default-cordis.yml"
    module_dir = tmp_path / "deepseek_harness_runtime"
    module_dir.mkdir()
    (module_dir / "__init__.py").write_text(
        f"""
def resolve_bundled_launch_args(mode=None):
    return ({str(runtime)!r},)


def bundled_default_config_path():
    return {str(default_config)!r}
""".strip()
    )

    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "deepseek_harness_runtime", raising=False)
    return default_config


@pytest.mark.parametrize("ambient_config", [None, ""], ids=["unset", "empty-counts-as-absent"])
def test_client_default_launch_uses_bundled_runtime_and_injects_default_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ambient_config: str | None
) -> None:
    env_dump = tmp_path / "env.json"
    default_config = _install_fake_bundled_runtime(tmp_path, monkeypatch)
    if ambient_config is None:
        monkeypatch.delenv("DSH_CORDIS_CONFIG", raising=False)
    else:
        monkeypatch.setenv("DSH_CORDIS_CONFIG", ambient_config)

    with HarnessClient(HarnessConfig(env={"ENV_DUMP": str(env_dump)})) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="deepseek-v4-pro")

    assert init.serverInfo.name == "bundled-runtime"
    assert json.loads(env_dump.read_text())["DSH_CORDIS_CONFIG"] == str(default_config)


def test_client_respects_explicit_config_over_bundled_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dump = tmp_path / "env.json"
    _install_fake_bundled_runtime(tmp_path, monkeypatch)
    monkeypatch.delenv("DSH_CORDIS_CONFIG", raising=False)

    with HarnessClient(
        HarnessConfig(env={"ENV_DUMP": str(env_dump), "DSH_CORDIS_CONFIG": "./explicit.yml"})
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="deepseek-v4-pro")

    assert json.loads(env_dump.read_text())["DSH_CORDIS_CONFIG"] == "./explicit.yml"


def _interactive_runtime(
    tmp_path: Path,
    malformed: bool = False,
    mismatched_resume: bool = False,
    mismatched_attachment: bool = False,
) -> tuple[str, ...]:
    script = tmp_path / (
        "interactive_malformed.py" if malformed else "interactive.py"
    )
    header = {
        "version": 0,
        "id": "saved",
        "createdAt": 7,
        "cwd": "/workspace",
        "parentSession": "parent",
        "seedLength": 0,
        "origin": "subagent",
        "delegationDepth": 1,
        "agentPreset": "worker",
    }
    valid = {
        "attachment/imageLimits": {
            "maxImageBytes": 1024,
            "maxImagesPerMessage": 4,
            "maxMessageImageBytes": 4096,
            "maxImagePixels": 1_000_000,
            "mediaTypes": ["image/png", "image/jpeg"],
        },
        "attachment/saveImage": {
            "attachmentId": "fake:attachment-1",
            "mediaType": "image/png",
            "bytes": 4 if mismatched_attachment else 3,
            "width": 1,
            "height": 1,
            "name": "pixel.png",
        },
        "llm/catalog": {
            "providers": [
                {
                    "id": "p",
                    "name": "Provider",
                    "models": [
                        {
                            "id": "m",
                            "name": "Model",
                            "inputModalities": ["text"],
                            "reasoning": {
                                "efforts": [
                                    {"id": "low", "name": "Low"},
                                    {"id": "high", "name": "High"},
                                ],
                                "defaultEffort": "high",
                            },
                        }
                    ],
                }
            ],
            "failures": [],
        },
        "provider/authInfo": {
            "provider": "p",
            "methods": [
                {"type": "api_key", "label": "API key"},
                {"type": "oauth", "label": "Subscription"},
            ],
            "configured": False,
        },
        "provider/authStart": {"flowId": "flow"},
        "provider/authRespond": {"accepted": True},
        "provider/authCancel": {"requested": True},
        "provider/authLogout": {"disconnected": True},
        "session/list": {
            "sessions": [{"header": header, "live": False, "persisted": True}]
        },
        "session/history": {
            "session": header,
            "events": [
                {"type": "turn/start", "seq": 0, "time": 8, "data": {"turn": 1}}
            ],
        },
        "session/resume": {"sessionId": "other" if mismatched_resume else "saved"},
        "interaction/respond": {"accepted": True},
        "session/selectModel": {
            "provider": "p",
            "model": "m",
            "reasoningEffort": "high",
        },
        "session/cancel": {"requested": True},
        "session/close": {"closed": True},
        "command/list": {
            "available": True,
            "commands": [{"name": "compact", "description": "Compact"}],
        },
        "command/execute": {
            "outcome": "success",
            "commandId": "cmd-1",
            "text": "done",
        },
        "shutdown": {},
    }
    invalid = {
        "attachment/imageLimits": {
            "maxImageBytes": "large",
            "maxImagesPerMessage": 4,
            "maxMessageImageBytes": 4096,
            "maxImagePixels": 1_000_000,
            "mediaTypes": ["image/png"],
        },
        "attachment/saveImage": {
            "attachmentId": "",
            "mediaType": "image/png",
            "bytes": 3,
            "width": 0,
            "height": 1,
        },
        "llm/catalog": {"providers": "bad", "failures": []},
        "provider/authInfo": {
            "provider": "",
            "methods": [{"type": "wat", "label": ""}],
            "configured": "no",
        },
        "provider/authStart": {"flowId": ""},
        "provider/authRespond": {"accepted": "yes"},
        "provider/authCancel": {"requested": "yes"},
        "provider/authLogout": {"disconnected": False},
        "session/list": {
            "sessions": [
                {
                    "header": {"version": 0, "id": "saved", "createdAt": True},
                    "live": 1,
                    "persisted": True,
                }
            ]
        },
        "session/history": {"session": {}, "events": []},
        "session/resume": {"sessionId": 7},
        "interaction/respond": {"accepted": "yes"},
        "session/selectModel": {"provider": 7},
        "session/cancel": {"requested": "yes"},
        "session/close": {},
        "command/list": {"available": True, "commands": [{"name": 1}]},
        "command/execute": {"outcome": "success"},
        "shutdown": {},
    }
    script.write_text(
        f"""
import json
import sys

malformed = {malformed!r}
valid = {valid!r}
invalid = {invalid!r}
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    result = (invalid if malformed else valid)[method]
    print(json.dumps({{"jsonrpc": "2.0", "id": msg["id"], "result": result}}), flush=True)
    if method == "shutdown":
        break
""".strip()
    )
    return (sys.executable, str(script))


def test_provider_auth_notification_models_are_strict() -> None:
    with pytest.raises(ValidationError):
        ProviderAuthPromptNotification.model_validate({
            "flowId": "flow", "provider": "p", "promptId": "prompt",
            "prompt": {"type": "secret", "message": "Key", "options": []},
        })
    with pytest.raises(ValidationError):
        ProviderAuthPromptNotification.model_validate({
            "flowId": "flow", "provider": "p", "promptId": "prompt",
            "prompt": {"type": "select", "message": "Account", "placeholder": "bad", "options": [
                {"id": "one", "label": "One"},
            ]},
        })
    with pytest.raises(ValidationError):
        ProviderAuthPromptNotification.model_validate({
            "flowId": "flow", "provider": "p", "promptId": "prompt",
            "prompt": {"type": "secret", "message": "Key", "options": None},
        })
    with pytest.raises(ValidationError):
        ProviderAuthPromptNotification.model_validate({
            "flowId": "flow", "provider": "p", "promptId": "prompt",
            "prompt": {"type": "secret", "message": "Key", "placeholder": None},
        })
    with pytest.raises(ValidationError):
        ProviderAuthPromptNotification.model_validate({
            "flowId": "flow", "provider": "p", "promptId": "prompt",
            "prompt": {"type": "select", "message": "Account", "options": [
                {"id": "one", "label": "One", "description": None},
            ]},
        })
    with pytest.raises(ValidationError):
        ProviderAuthEventNotification.model_validate({
            "flowId": "flow", "provider": "p",
            "event": {"type": "auth_url", "url": "https://example.test", "secret": "bad"},
        })
    with pytest.raises(ValidationError):
        ProviderAuthEventNotification.model_validate({
            "flowId": "flow", "provider": "p",
            "event": {"type": "info", "message": "Choose", "links": [{"url": ""}]},
        })
    with pytest.raises(ValidationError):
        ProviderAuthEventNotification.model_validate({
            "flowId": "flow", "provider": "p",
            "event": {"type": "info", "message": "Choose", "links": None},
        })
    with pytest.raises(ValidationError):
        ProviderAuthEventNotification.model_validate({
            "flowId": "flow", "provider": "p",
            "event": {
                "type": "device_code", "userCode": "code", "verificationUri": "https://example.test",
                "intervalSeconds": True,
            },
        })


def test_catalog_reasoning_rejects_invalid_efforts() -> None:
    with pytest.raises(ValidationError, match="at least 1 character"):
        ModelCatalogReasoning.model_validate({"efforts": [{"id": "", "name": "Empty"}]})
    with pytest.raises(ValidationError, match="must be unique"):
        ModelCatalogReasoning.model_validate(
            {"efforts": [{"id": "low", "name": "Low"}, {"id": "low", "name": "Low again"}]}
        )
    with pytest.raises(ValidationError, match="must name a supported effort"):
        ModelCatalogReasoning.model_validate(
            {"efforts": [{"id": "low", "name": "Low"}], "defaultEffort": "high"}
        )


def test_client_projects_interactive_session_controls(tmp_path: Path) -> None:
    config = HarnessConfig(launch_args_override=_interactive_runtime(tmp_path))
    with HarnessClient(config) as client:
        assert client.image_limits().max_image_bytes == 1024
        attachment = client.save_image(b"png", "image/png", "pixel.png")
        assert attachment.attachment_id == "fake:attachment-1"
        assert attachment.name == "pixel.png"
        auth_info = client.provider_auth_info("p")
        assert [method.type for method in auth_info.methods] == ["api_key", "oauth"]
        assert client.start_provider_auth("p", "oauth").flow_id == "flow"
        assert client.respond_provider_auth("flow", "prompt", "secret").accepted is True
        assert client.cancel_provider_auth("flow").requested is True
        assert client.logout_provider("p").disconnected is True
        model = client.list_models().providers[0].models[0]
        assert model.input_modalities == ["text"]
        assert model.reasoning is not None
        assert [effort.id for effort in model.reasoning.efforts] == ["low", "high"]
        assert model.reasoning.default_effort == "high"
        assert client.list_sessions().sessions[0].header.id == "saved"
        history = client.session_history("saved")
        assert history.events[0].type == "turn/start"
        assert history.session.agent_preset == "worker"
        assert client.resume_session("saved").session_id == "saved"
        assert client.respond_approval("a", "allowed-once").accepted is True
        assert client.respond_question("q", [{"id": "q", "selected": ["yes"]}]).accepted is True
        assert client.cancel_question("q").accepted is True
        assert client.select_model("main", "p", "m", "high").reasoning_effort == "high"
        assert client.cancel_session("main") is True
        assert client.close_session("main") is True
        assert client.list_commands("main").commands[0].name == "compact"
        assert client.execute_command("main", "/compact").command_id == "cmd-1"


@pytest.mark.parametrize(
    "operation",
    [
        lambda client: client.image_limits(),
        lambda client: client.save_image(b"png", "image/png"),
        lambda client: client.list_models(),
        lambda client: client.provider_auth_info("p"),
        lambda client: client.start_provider_auth("p", "oauth"),
        lambda client: client.respond_provider_auth("flow", "prompt", "secret"),
        lambda client: client.cancel_provider_auth("flow"),
        lambda client: client.logout_provider("p"),
        lambda client: client.list_sessions(),
        lambda client: client.session_history("saved"),
        lambda client: client.resume_session("saved"),
        lambda client: client.respond_approval("a", "allowed-once"),
        lambda client: client.select_model("main", "p", "m"),
        lambda client: client.cancel_session("main"),
        lambda client: client.close_session("main"),
        lambda client: client.list_commands("main"),
        lambda client: client.execute_command("main", "/compact"),
    ],
)
def test_client_rejects_malformed_interactive_responses(
    tmp_path: Path, operation: Callable[[HarnessClient], object]
) -> None:
    with HarnessClient(
        HarnessConfig(launch_args_override=_interactive_runtime(tmp_path, malformed=True))
    ) as client:
        with pytest.raises(ValidationError):
            operation(client)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (CommandListResponse, {"available": 1, "commands": []}),
        (
            CommandExecutionResponse,
            {"outcome": "success", "commandId": "cmd", "sourceEventSeq": True},
        ),
        (
            CommandExecutionResponse,
            {"outcome": "success", "commandId": "cmd", "sourceEventSeq": -1},
        ),
        (
            CommandExecutionResponse,
            {
                "outcome": "success",
                "commandId": "cmd",
                "sourceEventSeq": 9_007_199_254_740_992,
            },
        ),
    ],
)
def test_interactive_response_models_reject_non_wire_scalar_values(
    model: type[CommandListResponse] | type[CommandExecutionResponse],
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(
    "events",
    [
        [{"type": 7, "seq": 0, "time": 8, "data": {}}],
        [{"type": "turn/start", "seq": 0, "time": 8, "data": None}],
        [
            {"type": "turn/start", "seq": 0, "time": 8, "data": {"turn": 1}},
            {"type": "turn/end", "seq": 2, "time": 9, "data": {"turn": 1}},
        ],
        [
            {"type": "turn/start", "seq": 0, "time": 8, "data": {"turn": 1}},
            {"type": "turn/end", "seq": 0, "time": 9, "data": {"turn": 1}},
        ],
    ],
)
def test_session_history_rejects_malformed_or_noncontiguous_events(
    events: list[object],
) -> None:
    with pytest.raises(ValidationError):
        SessionHistoryResponse.model_validate(
            {
                "session": {"version": 0, "id": "saved", "createdAt": 7},
                "events": events,
            }
        )


@pytest.mark.parametrize(
    "surface_op",
    [
        None,
        [],
        {},
        "replace",
        {"op": "replace", "start": 0},
        {"op": "replace", "start": 0, "end": 1, "extra": True},
        {"op": "replace", "start": True, "end": 1},
        {"op": "replace", "start": -1, "end": 1},
        {"op": "other", "start": 0, "end": 1},
    ],
)
def test_session_history_rejects_null_array_or_malformed_surface_op(surface_op: object) -> None:
    with pytest.raises(ValidationError):
        SessionHistoryResponse.model_validate(
            {
                "session": {"version": 0, "id": "saved", "createdAt": 7},
                "events": [
                    {
                        "type": "turn/start",
                        "seq": 0,
                        "time": 8,
                        "data": {"turn": 1},
                        "surfaceOp": surface_op,
                    }
                ],
            }
        )


@pytest.mark.parametrize(
    "surface_op",
    ["append", {"op": "replace", "start": 0, "end": 9_007_199_254_740_991}],
)
def test_session_history_accepts_typescript_surface_op_variants(surface_op: object) -> None:
    history = SessionHistoryResponse.model_validate(
        {
            "session": {"version": 0, "id": "saved", "createdAt": 7},
            "events": [
                {
                    "type": "turn/start",
                    "seq": 0,
                    "time": 8,
                    "data": {"turn": 1},
                    "surfaceOp": surface_op,
                }
            ],
        }
    )
    assert history.events[0].surface_op is not None


def test_client_rejects_mismatched_resume_identity(tmp_path: Path) -> None:
    launch = _interactive_runtime(tmp_path, mismatched_resume=True)
    with HarnessClient(HarnessConfig(launch_args_override=launch)) as client:
        with pytest.raises(SdkProtocolError, match="session/resume returned 'other'"):
            client.resume_session("saved")


def test_client_rejects_mismatched_attachment_reference(tmp_path: Path) -> None:
    launch = _interactive_runtime(tmp_path, mismatched_attachment=True)
    with HarnessClient(HarnessConfig(launch_args_override=launch)) as client:
        with pytest.raises(SdkProtocolError, match="does not match requested bytes/media type"):
            client.save_image(b"png", "image/png")


def test_command_source_event_sequence_accepts_javascript_safe_integer_limit() -> None:
    response = CommandExecutionResponse.model_validate(
        {
            "outcome": "success",
            "commandId": "cmd",
            "sourceEventSeq": 9_007_199_254_740_991,
        }
    )
    assert response.source_event_seq == 9_007_199_254_740_991


def test_client_reports_missing_bundled_runtime_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "deepseek_harness_runtime", raising=False)
    monkeypatch.setattr(sys, "path", [])

    with pytest.raises(FileNotFoundError, match="Install deepseek-harness-runtime-bin"):
        HarnessClient().start()
