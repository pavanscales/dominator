import { render } from './generated/todo-render';

const root = document.getElementById('app')!;
root.appendChild(render());
