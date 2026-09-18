import assert from "node:assert/strict";
import test from "node:test";

import { latestTodoTasks, todoNotepadCard, todoTasksFromEvent } from "./notepad.js";

const tasks = [
  { id: 1, subject: "Inspect code", status: "completed" as const },
  { id: 2, subject: "Implement bridge", activeForm: "implementing bridge", status: "in_progress" as const },
  { id: 3, subject: "Old task", status: "deleted" as const },
];

test("todo tool results become bounded notepad cards", () => {
  const eventTasks = todoTasksFromEvent({
    type: "tool_execution_end",
    toolName: "todo",
    isError: false,
    result: { details: { tasks } },
  });
  assert.deepEqual(eventTasks, tasks);
  assert.deepEqual(todoNotepadCard(eventTasks!, 9, 1234), {
    revision: 9,
    updatedAt: 1234,
    markdown: "**1 of 2 tasks complete.**\n\nCurrent: implementing bridge",
    steps: [
      { step: "Inspect code", status: "completed" },
      { step: "implementing bridge", status: "in_progress" },
    ],
  });
});

test("latest persisted todo result restores the current branch snapshot", () => {
  assert.deepEqual(latestTodoTasks([
    { role: "toolResult", toolName: "todo", details: { tasks: [] } },
    { role: "assistant", content: [] },
    { role: "toolResult", toolName: "todo", details: { tasks } },
  ]), tasks);
  assert.deepEqual(latestTodoTasks([]), []);
  assert.equal(todoNotepadCard([], 1), null);
});

test("unrelated and malformed tool results are ignored", () => {
  assert.equal(todoTasksFromEvent({ type: "tool_execution_end", toolName: "read", result: {} }), undefined);
  assert.equal(todoTasksFromEvent({ type: "tool_execution_end", toolName: "todo", result: { details: { tasks: [{ id: 1 }] } } }), undefined);
});
