import type { NotepadCard } from "@clickclack/sdk-ts";

export type TodoTask = {
  id: number;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readTasks(value: unknown): TodoTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: TodoTask[] = [];
  for (const item of value) {
    const task = record(item);
    if (!task || typeof task.id !== "number" || !Number.isSafeInteger(task.id)
      || typeof task.subject !== "string" || !task.subject.trim()) return undefined;
    if (task.status !== "pending" && task.status !== "in_progress"
      && task.status !== "completed" && task.status !== "deleted") return undefined;
    tasks.push({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(typeof task.activeForm === "string" && task.activeForm.trim()
        ? { activeForm: task.activeForm }
        : {}),
    });
  }
  return tasks;
}

function tasksFromDetails(value: unknown): TodoTask[] | undefined {
  return readTasks(record(value)?.tasks);
}

export function todoTasksFromEvent(event: unknown): TodoTask[] | undefined {
  const value = record(event);
  if (!value || value.type !== "tool_execution_end" || value.toolName !== "todo" || value.isError === true) {
    return undefined;
  }
  return tasksFromDetails(record(value.result)?.details);
}

export function latestTodoTasks(messages: readonly unknown[]): TodoTask[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
    const tasks = tasksFromDetails(message.details);
    if (tasks) return tasks;
  }
  return [];
}

function stepText(task: TodoTask): string {
  const text = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
  return text.replace(/\s+/gu, " ").trim().slice(0, 500);
}

export function todoNotepadCard(
  tasks: readonly TodoTask[],
  revision: number,
  updatedAt = Date.now(),
): NotepadCard | null {
  const visible = tasks.filter(
    (task): task is TodoTask & { status: "pending" | "in_progress" | "completed" } => task.status !== "deleted",
  );
  if (visible.length === 0) return null;
  const completed = visible.filter((task) => task.status === "completed").length;
  const active = visible.find((task) => task.status === "in_progress");
  const summary = active
    ? `**${completed} of ${visible.length} tasks complete.**\n\nCurrent: ${stepText(active)}`
    : `**${completed} of ${visible.length} tasks complete.**`;
  return {
    revision,
    updatedAt,
    markdown: summary,
    steps: visible.slice(0, 50).map((task) => ({
      step: stepText(task),
      status: task.status,
    })),
  };
}
