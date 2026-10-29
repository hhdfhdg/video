import unittest
import os
import shutil
from pathlib import Path
from backend.tools import (
    TOOL_SPECS,
    TOOL_CATEGORIES,
    get_tools_by_category,
    list_modes,
    execute_tool,
    ToolError,
    WORKSPACE,
)


class TestTools(unittest.TestCase):
    def setUp(self):
        self.chat_id = "test_chat_123"
        self.chat_dir = WORKSPACE / self.chat_id
        if self.chat_dir.exists():
            shutil.rmtree(self.chat_dir)

    def tearDown(self):
        if self.chat_dir.exists():
            shutil.rmtree(self.chat_dir)

    def test_categories_and_modes(self):
        modes = list_modes()
        self.assertEqual(len(modes), len(TOOL_CATEGORIES))
        cat_ids = [m["id"] for m in modes]
        self.assertIn("files", cat_ids)
        self.assertIn("execution", cat_ids)

        tools_grouped = get_tools_by_category()
        self.assertIn("files", tools_grouped)
        self.assertIn("read_file", tools_grouped["files"]["tools"])

        files_tools = get_tools_by_category("files")
        self.assertIn("read_file", files_tools)
        self.assertIn("write_file", files_tools)

        with self.assertRaises(ToolError):
            get_tools_by_category("invalid_cat")

    def test_file_operations(self):
        # Write file
        success, res, info = execute_tool("write_file", {"path": "sub/hello.txt", "content": "Hello World!"}, self.chat_id)
        self.assertTrue(success)
        self.assertIn("Записано: sub/hello.txt", res)

        # List files
        success, res, info = execute_tool("list_files", {"path": "."}, self.chat_id)
        self.assertTrue(success)
        self.assertIn("sub", res)

        # Read file
        success, res, info = execute_tool("read_file", {"path": "sub/hello.txt"}, self.chat_id)
        self.assertTrue(success)
        self.assertEqual(res, "Hello World!")

        # Send file
        success, res, info = execute_tool("send_file", {"path": "sub/hello.txt"}, self.chat_id)
        self.assertTrue(success)
        self.assertEqual(info["path"], "sub/hello.txt")

    def test_run_code_python(self):
        code = "print('Test Python output')"
        success, res, info = execute_tool("run_code", {"language": "python", "code": code}, self.chat_id)
        self.assertTrue(success)
        self.assertIn("Test Python output", res)

    def test_invalid_tool_or_args(self):
        success, res, info = execute_tool("non_existent_tool", {}, self.chat_id)
        self.assertFalse(success)
        self.assertIn("не зарегистрирован", res)


if __name__ == "__main__":
    unittest.main()
