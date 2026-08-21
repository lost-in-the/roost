import { openSync, appendFileSync, closeSync, fsyncSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The "had to open the laptop" counter.
 *
 * This is the measurement instrument for the project's success metric, so it is
 * durable on purpose: every tap is fsync'd to disk before the caller is told it
 * succeeded, and the count is always read back from the file rather than held
 * in memory. A counter that loses taps measures nothing.
 */

const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function defaultLogPath() {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateHome, 'roost', 'laptop-opens.log');
}

export class LaptopLog {
  constructor({ path = defaultLogPath() } = {}) {
    this.path = path;
  }

  /** Every recorded timestamp, newest first. */
  entries() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => ISO_LINE.test(line))
      .reverse();
  }

  count() {
    return this.entries().length;
  }

  /**
   * Append one open and flush it to disk.
   * @returns {number} the new total
   */
  record(when = Date.now()) {
    mkdirSync(dirname(this.path), { recursive: true });

    // A previous write could have been truncated mid-line. Repair the boundary
    // rather than concatenating onto a partial entry.
    if (existsSync(this.path) && statSync(this.path).size > 0) {
      const tail = readFileSync(this.path, 'utf8').slice(-1);
      if (tail !== '\n') appendFileSync(this.path, '\n');
    }

    const line = new Date(when).toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n';
    const fd = openSync(this.path, 'a');
    try {
      appendFileSync(fd, line);
      fsyncSync(fd);           // survive a power cut, not just a process exit
    } finally {
      closeSync(fd);
    }
    return this.count();
  }
}
