import { signal } from '@dominator/core';

export const NODE_COUNT = 3000;

const getWidth = () => window.innerWidth;
const getHeight = () => window.innerHeight;

interface Node {
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    tx: number; // Target X
    ty: number; // Target Y
    transform: ReturnType<typeof signal<string>>;
    color: ReturnType<typeof signal<string>>;
}

export const nodes = signal<Node[]>([]);
export const mouse = { x: getWidth() / 2, y: getHeight() / 2 };
export const fps = signal(0);
export const mode = signal<'chaos' | 'form'>('chaos');

// Generate text targets
const createTextTargets = () => {
    const canvas = document.createElement('canvas');
    canvas.width = getWidth();
    canvas.height = getHeight();
    const ctx = canvas.getContext('2d')!;
    ctx.font = '900 15vw "Inter", sans-serif';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DOMINATOR', getWidth() / 2, getHeight() / 2);

    const imageData = ctx.getImageData(0, 0, getWidth(), getHeight()).data;
    const points: { x: number, y: number }[] = [];

    // Scan pixel data (step 4 for performance)
    for (let y = 0; y < getHeight(); y += 6) {
        for (let x = 0; x < getWidth(); x += 6) {
            const alpha = imageData[(y * getWidth() + x) * 4 + 3];
            if (alpha > 128) {
                points.push({ x, y });
            }
        }
    }
    return points;
};

const init = () => {
    const targets = createTextTargets();
    const list: Node[] = [];

    for (let i = 0; i < NODE_COUNT; i++) {
        const target = targets[i % targets.length];
        const x = Math.random() * getWidth();
        const y = Math.random() * getHeight();

        list.push({
            id: i,
            x,
            y,
            vx: (Math.random() - 0.5) * 5,
            vy: (Math.random() - 0.5) * 5,
            tx: target ? target.x : (Math.random() * getWidth()),
            ty: target ? target.y : (Math.random() * getHeight()),
            transform: signal(`translate3d(${x | 0}px, ${y | 0}px, 0)`),
            // Dynamic color signal for the shock effect
            color: signal('rgba(0, 112, 243, 0.8)')
        });
    }
    nodes.set(list);
};

// Defer init to ensure window is ready
setTimeout(init, 100);

let lastTime = performance.now();
let frames = 0;
let tick = 0;

const loop = () => {
    tick++;
    const now = performance.now();
    frames++;

    if (now > lastTime + 1000) {
        fps.set(Math.round((frames * 1000) / (now - lastTime)));
        lastTime = now;
        frames = 0;
    }

    const currentNodes = nodes();
    const mx = mouse.x;
    const my = mouse.y;
    const currentMode = mode();
    const isForming = currentMode === 'form';

    // Toggle mode every 300 ticks
    if (tick % 300 === 0) {
        mode.set(currentMode === 'chaos' ? 'form' : 'chaos');
    }

    const len = currentNodes.length;
    for (let i = 0; i < len; i++) {
        const n = currentNodes[i];

        if (isForming) {
            // Magnetic snap to text target
            const dx = n.tx - n.x;
            const dy = n.ty - n.y;

            n.vx += dx * 0.05; // Spring force
            n.vy += dy * 0.05;
            n.vx *= 0.85;      // Heavy damping
            n.vy *= 0.85;

            // Jitter
            if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
                n.color.set('#fff'); // Flash white when locked
            } else {
                n.color.set('rgba(0, 112, 243, 0.8)');
            }
        } else {
            // Chaos physics
            const dx = mx - n.x;
            const dy = my - n.y;
            const distSq = dx * dx + dy * dy;

            if (distSq < 250000) { // Mouse repel
                const dist = Math.sqrt(distSq);
                const force = (500 - dist) / 500;
                n.vx -= dx * force * 0.1; // Repel
                n.vy -= dy * force * 0.1;
                n.color.set('rgba(255, 0, 80, 0.9)'); // Angry red
            } else {
                n.color.set('rgba(0, 112, 243, 0.4)'); // Calm blue
            }

            // Brownian motion
            n.vx += (Math.random() - 0.5) * 0.2;
            n.vy += (Math.random() - 0.5) * 0.2;

            n.vx *= 0.96;
            n.vy *= 0.96;
        }

        n.x += n.vx;
        n.y += n.vy;

        // Wrap only in chaos mode
        if (!isForming) {
            if (n.x < 0) n.x = getWidth();
            else if (n.x > getWidth()) n.x = 0;
            if (n.y < 0) n.y = getHeight();
            else if (n.y > getHeight()) n.y = 0;
        }

        n.transform.set(`translate3d(${n.x | 0}px, ${n.y | 0}px, 0)`);
    }

    requestAnimationFrame(loop);
};

loop();

window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
});

// Click to force explode
window.addEventListener('mousedown', () => {
    mode.set('chaos');
    const currentNodes = nodes();
    for (const n of currentNodes) {
        n.vx = (Math.random() - 0.5) * 50;
        n.vy = (Math.random() - 0.5) * 50;
    }
});

export const getNodes = () => nodes();
