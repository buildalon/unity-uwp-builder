import path = require('path');
import { execSync } from 'child_process';

export function expectDiffToMatch(actualDiff: string, expectedDiff: string) {
  const normalize = (str: string) => str.replace(/\r\n/g, '\n').trim();
  const filterDiff = (str: string) => normalize(str)
    .split('\n')
    .filter(line => !/^diff --git |^index |^--- |^\+\+\+ /.test(line))
    .join('\n');
  expect(filterDiff(actualDiff)).toBe(filterDiff(expectedDiff));
}

export function getFileDiff(sourcePath: string, resultPath: string): string {
  // Normalize paths for git on Windows
  const src = sourcePath.replace(/\\/g, '/');
  const res = resultPath.replace(/\\/g, '/');
  try {
    return execSync(`git diff --no-index "${src}" "${res}"`, {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '../../..')
    });
  } catch (err: any) {
    return err.stdout ? err.stdout.toString() : err.message;
  }
}
