/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screenCheckUploaded } from '../screen-check';

describe('screen-check agent contract', () => {
  it('plans public web, authenticated recipes, images, windows and ambiguous requests', async () => {
    const recipe = Buffer.from(JSON.stringify({ url: 'https://app.test', auth: { storage_state: 'state.json' }, actions: [{ action: 'click', selector: '#go' }] }));
    await expect(screenCheckUploaded(['plan', '--target', 'https://example.test'], {}, '/tmp/unused')).resolves.toEqual(expect.objectContaining({ recommended_type: 'web' }));
    await expect(screenCheckUploaded(['plan', '--recipe', 'recipe.json'], { 'recipe.json': recipe }, '/tmp/unused')).resolves.toEqual(expect.objectContaining({ recommended_type: 'web-recipe', preparation: { authenticated: true, actions: 1 } }));
    await expect(screenCheckUploaded(['plan', '--target', 'shot.png'], { 'shot.png': Buffer.from('x') }, '/tmp/unused')).resolves.toEqual(expect.objectContaining({ recommended_type: 'image' }));
    await expect(screenCheckUploaded(['plan', '--window-id', '42'], {}, '/tmp/unused')).resolves.toEqual(expect.objectContaining({ recommended_type: 'window' }));
    await expect(screenCheckUploaded(['plan'], {}, '/tmp/unused')).resolves.toEqual(expect.objectContaining({ recommended_type: 'choose' }));
  });

  it('publishes one complete provider-neutral contract and decision guide', async () => {
    const help = String((await screenCheckUploaded(['--help'], {}, '/tmp/unused')).help);
    const schema = (await screenCheckUploaded(['--schema'], {}, '/tmp/unused')).schema as any;
    expect(help).toContain('screen-check plan');
    expect(help).toContain('No mode inherits');
    expect(schema.actions).toContain('plan');
    expect(schema.browser_recipe.actions).toEqual(expect.arrayContaining(['click', 'fill', 'upload', 'wait_for_text']));
    const skill = readFileSync(join(process.cwd(), 'machinery/skills/atelier/SKILL.md'), 'utf8');
    expect(skill).toContain('| Login, cookies, headers, clicks, typing');
    expect(skill).toContain('never arbitrary script execution');
    expect(skill).toContain('Keep secrets in a temporary');
  });
});
