import {
  applyPatchTool,
  globTool,
  listDirectoryTool,
  listDirectoryCompatTool,
  readFileTool,
  readFileCompatTool,
  readManyFilesTool,
  readVisualFileTool,
  replaceTool,
  searchFileContentTool,
  writeFileTool,
} from "./builtin/file-tools.js";
import { runShellCommandTool } from "./builtin/shell-tools.js";
import {
  askUserTool,
  completeTaskTool,
  saveMemoryTool,
  saveMemoryCompatTool,
  writeTodosTool,
} from "./builtin/session-tools.js";
import { webFetchTool, webSearchTool } from "./builtin/web-tools.js";
import type { ToolImplementation } from "./types.js";

async function backgroundTaskManageStub(): Promise<Record<string, unknown>> {
  return {
    supported: false,
    message: "BackgroundTaskManage is not implemented in Node rewrite yet",
  };
}

const IMPLEMENTATIONS_BY_BINDING: Record<string, ToolImplementation> = {
  "nexau.archs.tool.builtin.file_tools:read_file": readFileCompatTool,
  "nexau.archs.tool.builtin.file_tools:write_file": writeFileTool,
  "nexau.archs.tool.builtin.file_tools:replace": replaceTool,
  "nexau.archs.tool.builtin.file_tools:list_directory": listDirectoryCompatTool,
  "nexau.archs.tool.builtin.file_tools:glob": globTool,
  "nexau.archs.tool.builtin.file_tools:search_file_content": searchFileContentTool,
  "nexau.archs.tool.builtin.file_tools:read_many_files": readManyFilesTool,
  "nexau.archs.tool.builtin.file_tools:apply_patch": applyPatchTool,
  "nexau.archs.tool.builtin.file_tools:read_visual_file": readVisualFileTool,
  "nexau.archs.tool.builtin.shell_tools:run_shell_command": runShellCommandTool,
  "nexau.archs.tool.builtin.web_tools:google_web_search": webSearchTool,
  "nexau.archs.tool.builtin.web_tools:web_fetch": webFetchTool,
  "nexau.archs.tool.builtin.session_tools:save_memory": saveMemoryCompatTool,
  "nexau.archs.tool.builtin.session_tools:write_todos": writeTodosTool,
  "nexau.archs.tool.builtin.session_tools:ask_user": askUserTool,
  "nexau.archs.tool.builtin.session_tools:complete_task": completeTaskTool,
  "nexau.archs.tool.builtin:background_task_manage_tool": backgroundTaskManageStub,
};

const IMPLEMENTATIONS_BY_TOOL_NAME: Record<string, ToolImplementation> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  replace: replaceTool,
  list_directory: listDirectoryTool,
  glob: globTool,
  search_file_content: searchFileContentTool,
  read_many_files: readManyFilesTool,
  apply_patch: applyPatchTool,
  read_visual_file: readVisualFileTool,
  run_shell_command: runShellCommandTool,
  Bash: runShellCommandTool,
  web_search: webSearchTool,
  web_read: webFetchTool,
  WebSearch: webSearchTool,
  WebRead: webFetchTool,
  WebFetch: webFetchTool,
  save_memory: saveMemoryTool,
  write_todos: writeTodosTool,
  TodoWrite: writeTodosTool,
  Write: writeFileTool,
  ask_user: askUserTool,
  complete_task: completeTaskTool,
  BackgroundTaskManage: backgroundTaskManageStub,
};

export function resolveToolImplementation(
  bindingPath: string | undefined,
  toolName: string,
): ToolImplementation | undefined {
  if (bindingPath && bindingPath in IMPLEMENTATIONS_BY_BINDING) {
    return IMPLEMENTATIONS_BY_BINDING[bindingPath];
  }

  return IMPLEMENTATIONS_BY_TOOL_NAME[toolName];
}
