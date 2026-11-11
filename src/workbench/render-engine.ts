import { renderArtifact, type RenderArtifact, type RenderExpression } from './render-model';

export type RenderFrames = Float32Array[][]; // frame -> buffer -> interleaved channels
export function computeRender(input: unknown, overrides: Record<string, number> = {}): RenderFrames {
  const model = renderArtifact(input);
  if (!model) throw new Error('Invalid rendering model or computation budget exceeded.');
  const vars: Record<string, number> = Object.create(null);
  Object.assign(vars, { width: model.width, height: model.height, x: 0, y: 0, frame: 0 });
  for (const name of Object.keys(overrides)) if (!model.parameters.some(p => p.id === name)) throw new Error(`Unknown parameter: ${name}`);
  for (const p of model.parameters) {
    const value = overrides[p.id] ?? p.value;
    if (!Number.isFinite(value) || value < p.min || value > p.max) throw new Error(`Parameter out of range: ${p.label}`);
    vars[p.id] = value;
  }
  const indices = new Map(model.buffers.map((b, i) => [b.id, i]));
  const frames: RenderFrames = [];
  const evaluate = (expr: RenderExpression, frame: number): number => {
    if (typeof expr === 'number') return expr;
    if (typeof expr === 'string') return vars[expr]!;
    const op = expr[0] as string;
    if (op === 'sample') {
      const index = indices.get(expr[1] as string)!; const buffer = model.buffers[index]!;
      const channel = expr[2] as number;
      const x = Math.max(0, Math.min(model.width - 1, Math.floor(evaluate(expr[3]!, frame) + .5)));
      const y = Math.max(0, Math.min(model.height - 1, Math.floor(evaluate(expr[4]!, frame) + .5)));
      const source = expr[5] === 'previous' ? frame - 1 : frame;
      return source < 0 ? buffer.initial?.[channel] ?? 0 : frames[source]![index]![(y * model.width + x) * buffer.channels.length + channel]!;
    }
    const a = evaluate(expr[1]!, frame);
    if (op === 'if') return evaluate(expr[a !== 0 ? 2 : 3]!, frame);
    const b = expr.length > 2 ? evaluate(expr[2]!, frame) : 0;
    const c = expr.length > 3 ? evaluate(expr[3]!, frame) : 0;
    let result: number;
    switch (op) {
      case 'add': result = a + b; break; case 'sub': result = a - b; break;
      case 'mul': result = a * b; break; case 'div': result = a / b; break; case 'mod': result = a % b; break;
      case 'min': result = Math.min(a, b); break; case 'max': result = Math.max(a, b); break;
      case 'abs': result = Math.abs(a); break; case 'floor': result = Math.floor(a); break;
      case 'sin': result = Math.sin(a); break; case 'cos': result = Math.cos(a); break; case 'sqrt': result = Math.sqrt(a); break;
      case 'lt': result = +(a < b); break; case 'le': result = +(a <= b); break;
      case 'gt': result = +(a > b); break; case 'ge': result = +(a >= b); break; case 'eq': result = +(a === b); break;
      case 'and': result = +(a !== 0 && b !== 0); break; case 'or': result = +(a !== 0 || b !== 0); break;
      case 'mix': result = a * (1 - c) + b * c; break;
      case 'clamp': result = Math.max(b, Math.min(c, a)); break;
      default: throw new Error('Unsupported operation.');
    }
    if (!Number.isFinite(result) || Math.abs(result) > 1e12) throw new Error(`Invalid numerical result at frame ${frame}, pixel (${vars.x}, ${vars.y}).`);
    return result;
  };
  for (let frame = 0; frame < model.frames; frame++) {
    vars.frame = frame; frames.push([]);
    model.buffers.forEach(buffer => {
      const data = new Float32Array(model.width * model.height * buffer.channels.length);
      for (let y = 0; y < model.height; y++) for (let x = 0; x < model.width; x++) {
        vars.x = x; vars.y = y;
        buffer.values.forEach((expr, c) => { data[(y * model.width + x) * buffer.channels.length + c] = evaluate(expr, frame); });
      }
      frames[frame]!.push(data);
    });
  }
  return frames;
}

export function renderPixel(data: Float32Array, model: RenderArtifact, bufferIndex: number, x: number, y: number): number[] {
  const channels = model.buffers[bufferIndex]!.channels.length;
  return Array.from(data.slice((y * model.width + x) * channels, (y * model.width + x + 1) * channels));
}
export function displayRender(data: Float32Array, channels: number, view: RenderArtifact['views'][number]): Uint8ClampedArray {
  const image = new Uint8ClampedArray(data.length / channels * 4);
  const normalize = (v: number) => Math.max(0, Math.min(1, (v - view.range[0]) / (view.range[1] - view.range[0])));
  const encode = (v: number) => view.display === 'rgb' && view.encoding === 'linear' ? v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055 : v;
  for (let i = 0; i < data.length / channels; i++) {
    const values = view.channels.map(c => encode(normalize(data[i * channels + c]!)));
    image[i * 4] = values[0]! * 255;
    image[i * 4 + 1] = (values[1] ?? values[0])! * 255;
    image[i * 4 + 2] = (view.display === 'vector' ? .5 : values[2] ?? values[0])! * 255;
    image[i * 4 + 3] = 255;
  }
  return image;
}
