import { create } from 'zustand';

import type { QualificationAnswer, QualificationTask } from './contracts';

interface WorkbenchState {
  task: QualificationTask;
  answers: QualificationAnswer[];
  setTask: (task: QualificationTask) => void;
  replaceAnswers: (answers: readonly QualificationAnswer[]) => void;
  addAnswer: (answer: QualificationAnswer) => void;
  removeAnswer: (index: number) => void;
  moveAnswer: (from: number, to: number) => void;
  reset: () => void;
}

const initialState = {
  task: 'textual_kis' as QualificationTask,
  answers: [] as QualificationAnswer[],
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  ...initialState,
  setTask: (task) => set({ task, answers: [] }),
  replaceAnswers: (answers) => set({ answers: [...answers].slice(0, 100) }),
  addAnswer: (answer) => set((state) => (
    state.answers.length >= 100 ? state : { answers: [...state.answers, answer] }
  )),
  removeAnswer: (index) => set((state) => ({
    answers: state.answers.filter((_, answerIndex) => answerIndex !== index),
  })),
  moveAnswer: (from, to) => set((state) => {
    if (from < 0 || from >= state.answers.length || to < 0 || to >= state.answers.length || from === to) return state;
    const next = [...state.answers];
    const [answer] = next.splice(from, 1);
    next.splice(to, 0, answer);
    return { answers: next };
  }),
  reset: () => set({ ...initialState, answers: [] }),
}));
