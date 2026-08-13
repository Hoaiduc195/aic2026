import { Injectable } from '@nestjs/common';

import type { TaskType } from '../common/types';
import type { TaskExecutor } from './task-executor';

@Injectable()
export class TaskExecutorRegistry {
  private readonly executors = new Map<TaskType, TaskExecutor>();

  register(executor: TaskExecutor): void {
    if (this.executors.has(executor.task)) {
      throw new Error(`task executor already registered: ${executor.task}`);
    }
    this.executors.set(executor.task, executor);
  }

  resolve(task: TaskType): TaskExecutor {
    const executor = this.executors.get(task);
    if (!executor) throw new Error(`no executor registered for task: ${task}`);
    return executor;
  }

  names(): string[] {
    return [...this.executors.values()].map((executor) => executor.name);
  }
}
