import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parse } from '../packages/core/src/compiler/parse.ts';
import { ssa } from '../packages/core/src/compiler/ssa.ts';
import { optimize } from '../packages/core/src/compiler/optimize.ts';
import { codegen } from '../packages/core/src/compiler/codegen.ts';

const compile = (inputFile: string, outputFile: string, functionName?: string) => {
    console.log(`Starting compilation of ${inputFile}...`);
    const template = fs.readFileSync(inputFile, 'utf-8');
    console.log('Template read. Parsing...');
    const ast = parse(template);
    console.log('AST generated. Running SSA...');
    const instructions = ssa(ast);
    console.log('SSA instructions generated. Optimizing...');
    const optimized = optimize(instructions);
    console.log('Optimized. Generating code...');
    const code = codegen(optimized, functionName);
    console.log('Code generated. Writing to file...');

    const dir = path.dirname(outputFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputFile, code);
    console.log(`Compiled ${inputFile} -> ${outputFile}`);
};

const buildZigWasm = () => {
    const zigDir = path.join(process.cwd(), 'packages/core/src/zig');
    const distDir = path.join(process.cwd(), 'packages/core/dist/zig');
    const zig = 'zig';

    if (!fs.existsSync(zigDir)) {
        console.log('Zig source directory not found, skipping WASM build.');
        return;
    }

    console.log('Building Zig WASM modules...');
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

    try {
        // Build object files
        execSync(
            `${zig} build-obj -target wasm32-freestanding -fno-entry --name dominator_core "${path.join(zigDir, 'dominator_core.zig')}"`,
            { cwd: zigDir, stdio: 'inherit', timeout: 60000 }
        );
        // Link to standalone .wasm
        execSync(
            `${zig} wasm-ld --no-entry --import-memory --export-dynamic --strip-debug -o "${path.join(distDir, 'dominator_core.wasm')}" "${path.join(zigDir, 'dominator_core.o.o')}"`,
            { cwd: zigDir, stdio: 'inherit', timeout: 30000 }
        );
        console.log('  dominator_core.wasm built.');

        // Build physics object
        execSync(
            `${zig} build-obj -target wasm32-freestanding -fno-entry --name physics "${path.join(zigDir, 'physics.zig')}"`,
            { cwd: zigDir, stdio: 'inherit', timeout: 60000 }
        );
        // Link physics (needs --allow-undefined for fmaxf import)
        execSync(
            `${zig} wasm-ld --no-entry --import-memory --export-dynamic --strip-debug --allow-undefined -o "${path.join(distDir, 'physics.wasm')}" "${path.join(zigDir, 'physics.o.o')}"`,
            { cwd: zigDir, stdio: 'inherit', timeout: 30000 }
        );
        console.log('  physics.wasm built.');
    } catch (err) {
        console.error('Zig WASM build failed:', err);
    }
};

const inputFile = process.argv[2];
const outputFile = process.argv[3];
const functionName = process.argv[4];

// Check for --build-wasm flag
if (process.argv.includes('--build-wasm')) {
    buildZigWasm();
}

if (inputFile && outputFile) {
    const inputPath = path.isAbsolute(inputFile) ? inputFile : path.join(process.cwd(), inputFile);
    const outputPath = path.isAbsolute(outputFile) ? outputFile : path.join(process.cwd(), outputFile);

    if (fs.existsSync(inputPath)) {
        compile(inputPath, outputPath, functionName);
    } else {
        console.error(`Template not found: ${inputPath}`);
    }
} else if (!process.argv.includes('--build-wasm')) {
    // Fallback to todo example if no args
    const todoTemplate = path.join(process.cwd(), 'packages/todo-example/src/templates/todo-list.dnr');
    const todoOutput = path.join(process.cwd(), 'packages/todo-example/src/generated/todo-render.ts');

    if (fs.existsSync(todoTemplate)) {
        compile(todoTemplate, todoOutput);
    } else {
        console.error(`Template not found: ${todoTemplate}`);
    }
}
