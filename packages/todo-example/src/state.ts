import { signal, computed } from '@dominator/core';

export interface Todo {
    id: number;
    text: string;
    done: boolean;
}

export const todos = signal<Todo[]>([]);
export const remainingCount = computed(() => todos().filter((t: Todo) => !t.done).length);

export const addTodo = () => {
    const input = document.getElementById('todo-input') as HTMLInputElement;
    const text = input?.value?.trim();
    if (!text) return;
    todos.set([...todos(), { id: Date.now(), text, done: false }]);
    if (input) input.value = '';
};

export const toggleTodo = (id: number) => {
    todos.set(todos().map((t: Todo) => t.id === id ? { ...t, done: !t.done } : t));
};

export const deleteTodo = (id: number) => {
    todos.set(todos().filter((t: Todo) => t.id !== id));
};
