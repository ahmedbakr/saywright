export interface Task {
  id: number;
  title: string;
  done: boolean;
}

/** How many tasks are still to do. */
export function leftOf(tasks: Task[]): number {
  return tasks.filter((t) => t.done).length;
}

export function label(n: number): string {
  return `${n} ${n === 1 ? 'task' : 'tasks'} left`;
}
