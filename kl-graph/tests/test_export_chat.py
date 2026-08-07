"""Offline regression tests for the direct Chat exporter."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "skills" / "dws-personal-data-dump" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import _export_common
import export_chat


def _args(output: Path, **overrides):
    values = {
        "output": str(output),
        "fresh": False,
        "since": None,
        "until": "2026-07-28 23:59:59",
        "max_conversations": 0,
        "max_messages_per_conv": 0,
        "groups_only": False,
        "skip_topic_replies": False,
        "skip_media": True,
        "force_finish": False,
        "auth_probe": False,
        "skip_auth_probe": False,
        "auth_probe_timeout": 1.0,
        "auth_probe_interval": 0.01,
        "delay": 0.0,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def _jsonl(path: Path):
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class ExportChatTest(unittest.TestCase):
    def test_parser_defaults_to_full_history_without_auth_polling(self):
        args = export_chat.build_parser().parse_args(["--output", "out"])
        self.assertIsNone(args.since)
        self.assertFalse(args.auth_probe)
        self.assertFalse(args.skip_topic_replies)

    def test_conversation_cursor_is_exhausted(self):
        responses = [
            {
                "result": {
                    "conversationList": [
                        {"openConversationId": "cid-1", "title": "One"}
                    ],
                    "hasMore": True,
                    "nextCursor": 8,
                }
            },
            {
                "result": {
                    "conversationList": [
                        {"openConversationId": "cid-2", "title": "Two"}
                    ],
                    "hasMore": False,
                }
            },
        ]
        with mock.patch.object(
            export_chat, "run_dws", side_effect=responses
        ) as run_dws:
            conversations = export_chat.list_all_conversations(0)
        self.assertEqual(
            [item["openConversationId"] for item in conversations],
            ["cid-1", "cid-2"],
        )
        self.assertEqual(run_dws.call_args_list[1].args[0][-2:], ["--cursor", "8"])

    def test_message_pages_are_filtered_and_repeated_boundary_fails(self):
        responses = [
            {
                "result": {
                    "messages": [
                        {"openMessageId": "m3", "createTime": "2026-07-28 12:00:00"},
                        {"openMessageId": "m2", "createTime": "2026-07-28 11:00:00"},
                    ],
                    "hasMore": True,
                }
            },
            {
                "result": {
                    "messages": [
                        {"openMessageId": "m2", "createTime": "2026-07-28 11:00:00"}
                    ],
                    "hasMore": True,
                }
            },
        ]
        with mock.patch.object(export_chat, "run_dws", side_effect=responses):  # noqa: SIM117
            with self.assertRaisesRegex(export_chat.ChatExportError, "did not move"):
                list(
                    export_chat.iter_messages_backwards(
                        "cid", "2026-07-28 23:59:59", None, 0, 0
                    )
                )

    def test_unbounded_run_exports_topic_replies(self):
        calls = []

        def dws(command):
            calls.append(list(command))
            if command[:2] == ["chat", "list-all-conversations"]:
                return {
                    "result": {
                        "conversationList": [
                            {
                                "openConversationId": "cid-1",
                                "title": "Group",
                                "groupType": "INTERNAL_GROUP",
                            }
                        ],
                        "hasMore": False,
                    }
                }
            if command[:3] == ["chat", "message", "list-topic-replies"]:
                return {
                    "result": {
                        "messages": [
                            {
                                "openMessageId": "reply-1",
                                "createTime": "2026-07-28 10:01:00",
                                "content": "reply",
                            }
                        ],
                        "hasMore": False,
                    }
                }
            if command[:3] == ["chat", "message", "list"]:
                return {
                    "result": {
                        "messages": [
                            {
                                "openMessageId": "topic-1",
                                "openConvThreadId": "thread-1",
                                "createTime": "2026-07-28 10:00:00",
                                "content": "topic",
                            }
                        ],
                        "hasMore": False,
                    }
                }
            self.fail("unexpected DWS command: %r" % command)  # noqa: UP031

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "chat"
            with mock.patch.object(export_chat, "run_dws", side_effect=dws):
                status = export_chat.run(_args(output))
            records = _jsonl(output / "records.jsonl")
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(status, 0)
        self.assertEqual({record["data"]["openMessageId"] for record in records}, {
            "topic-1", "reply-1"
        })
        self.assertEqual(manifest["record_types"], ["message"])
        self.assertTrue(any(call[:3] == ["chat", "message", "list-topic-replies"] for call in calls))

    def test_conversation_listing_failure_stays_partial(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "chat"
            with mock.patch.object(
                export_chat,
                "run_dws",
                return_value={"error": {"message": "temporary"}},
            ) as run_dws:
                status = export_chat.run(_args(output))
            checkpoint = json.loads(
                (output / "_checkpoint.json").read_text(encoding="utf-8")
            )
        self.assertEqual(status, 1)
        self.assertEqual(run_dws.call_count, 2)
        self.assertFalse((output / "manifest.json").exists())
        self.assertIn(export_chat.WORKSPACE_ID, checkpoint["scopes_partial"])

    def test_legacy_dws_error_fields_are_not_reported_as_invalid_response(self):
        response = {
            "error": {
                "errorCode": "AUTH_PERMISSION_DENIED",
                "errorMsg": "Permission denied",
            }
        }
        with mock.patch.object(export_chat, "run_dws", return_value=response):  # noqa: SIM117
            with self.assertRaises(export_chat.ChatExportError) as raised:
                export_chat.run_dws_checked(
                    ["chat", "message", "list"],
                    "chat message list (cid)",
                    lambda value: export_chat._message_list(value) is not None,
                )
        self.assertEqual(raised.exception.code, "AUTH_PERMISSION_DENIED")
        self.assertEqual(raised.exception.message, "Permission denied")

    def test_zero_exit_legacy_dws_error_envelope_is_rejected(self):
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps({
                "success": True,
                "errorCode": "AUTH_PERMISSION_DENIED",
                "errorMsg": "Permission denied",
                "result": None,
            }),
            stderr="",
        )
        with mock.patch.object(
            _export_common.subprocess, "run", return_value=completed
        ) as run:
            response = _export_common.run_dws(["chat", "message", "list"])
        self.assertEqual(
            response["error"]["errorCode"], "AUTH_PERMISSION_DENIED"
        )
        self.assertNotIn("timeout", run.call_args.kwargs)

    def test_invalid_success_response_reports_shape_without_message_content(self):
        response = {
            "success": True,
            "result": {"hasMore": False, "payload": "private message"},
        }
        with mock.patch.object(export_chat, "run_dws", return_value=response):  # noqa: SIM117
            with self.assertRaises(export_chat.ChatExportError) as raised:
                export_chat.run_dws_checked(
                    ["chat", "message", "list"],
                    "chat message list (cid)",
                    lambda value: export_chat._message_list(value) is not None,
                )
        self.assertEqual(raised.exception.code, "INVALID_RESPONSE")
        self.assertIn("result_keys", raised.exception.message)
        self.assertNotIn("private message", raised.exception.message)

    def test_media_download_forces_json_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            media_root = Path(temp_dir) / "media"
            saved = media_root / "ddmedia" / "abc.jpg"
            saved.parent.mkdir(parents=True)
            saved.write_bytes(b"image")
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps({"success": True, "result": {"path": str(saved)}}),
                stderr="",
            )
            with mock.patch.object(
                export_chat.subprocess, "run", return_value=completed
            ) as run:
                relative = export_chat.download_media(
                    "$abc", "msg", "cid", media_root
                )
        self.assertEqual(relative, "ddmedia/abc.jpg")
        self.assertIn("--format", run.call_args.args[0])
        self.assertIn("json", run.call_args.args[0])
        self.assertNotIn("timeout", run.call_args.kwargs)

    def test_invalid_date_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "chat"
            with self.assertRaises(export_chat.ChatExportError):
                export_chat.run(_args(output, since="2026/07/28"))
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
