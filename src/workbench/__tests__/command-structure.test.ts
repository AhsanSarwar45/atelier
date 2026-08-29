import { describe, expect, it } from 'vitest';

import { commandStructure, maskHereDocuments } from '@/workbench/command-structure';

const SABOTAGE = [
  'rm -rf /tmp/private && mkdir -p /tmp/private && cp -r /private/source /tmp/private && cd /tmp/private && python3 - <<\'EOF\'',
  'from pathlib import Path',
  "p = Path('private.py')",
  'p.write_text(\'private\')',
  'EOF',
  '/tmp/private-venv/bin/python -m pytest private/test.py -q 2>&1 | tail -8',
].join('\n');

describe('privacy-safe compound command structure', () => {
  it('keeps top-level stages separate from an embedded Python body', () => {
    expect(commandStructure(SABOTAGE)).toEqual({
      compound: true,
      profile: 'rm>mkdir>cp>python-heredoc>pytest',
      stages: ['rm', 'mkdir', 'cp', 'python-heredoc', 'pytest'],
      heredocs: 1,
    });
  });

  it('retains commands after the delimiter and removes every private argument and body line', () => {
    const structure = commandStructure(SABOTAGE);
    expect(JSON.stringify(structure)).not.toMatch(/private|pathlib|write_text|source|test\.py/i);
    expect(maskHereDocuments(SABOTAGE).visible).not.toContain('pathlib');
  });

  it('distinguishes executable and data here-documents', () => {
    expect(commandStructure("python3 - <<'PY'\nprint('x')\nPY").profile).toBe('python-heredoc');
    expect(commandStructure("cat > out.txt <<'EOF'\nrm is data\nEOF").profile).toBe('data-heredoc');
    expect(commandStructure("bash <<'SH'\nrm -rf x\nSH").profile).toBe('shell-heredoc');
    expect(commandStructure("<<'DATA'\ntext\nDATA").profile).toBe('anonymous-heredoc');
    expect(commandStructure("python3 <<'PY-3'\nprint('x')\nPY-3").profile).toBe('python-heredoc');
    expect(commandStructure("cat <<\\123\ntext\n123").profile).toBe('data-heredoc');
  });
});
