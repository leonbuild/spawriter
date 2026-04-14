/**
 * Tests for CLI argument parsing logic.
 * Tests the arg-parsing logic without actually starting servers.
 *
 * Run: npx tsx --test mcp/src/cli.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PORT } from './utils.js';

// ---------------------------------------------------------------------------
// Replicate the CLI arg-parsing logic (mirrors cli.ts)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | undefined;
  port: number;
  help: boolean;
  version: boolean;
}

function parseCLIArgs(argv: string[]): ParsedArgs {
  const args = argv;
  const command = args[0];
  const portFlagIndex = args.indexOf('--port');
  const parsedPort =
    portFlagIndex >= 0 && args[portFlagIndex + 1]
      ? parseInt(args[portFlagIndex + 1], 10)
      : NaN;
  const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
  const help = args.includes('--help') || args.includes('-h');
  const version = args.includes('--version') || args.includes('-v');

  return { command, port, help, version };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI argument parsing', () => {
  describe('command detection', () => {
    it('should detect "relay" command', () => {
      const result = parseCLIArgs(['relay']);
      assert.equal(result.command, 'relay');
    });

    it('should detect "serve" command', () => {
      const result = parseCLIArgs(['serve']);
      assert.equal(result.command, 'serve');
    });

    it('should be undefined with no args', () => {
      const result = parseCLIArgs([]);
      assert.equal(result.command, undefined);
    });

    it('should capture unknown commands', () => {
      const result = parseCLIArgs(['unknown']);
      assert.equal(result.command, 'unknown');
    });
  });

  describe('port parsing', () => {
    it('should default to DEFAULT_PORT when no --port', () => {
      const result = parseCLIArgs(['serve']);
      assert.equal(result.port, DEFAULT_PORT);
    });

    it('should parse --port value', () => {
      const result = parseCLIArgs(['serve', '--port', '8888']);
      assert.equal(result.port, 8888);
    });

    it('should fall back to DEFAULT_PORT for non-numeric port', () => {
      const result = parseCLIArgs(['serve', '--port', 'abc']);
      assert.equal(result.port, DEFAULT_PORT);
    });

    it('should fall back to DEFAULT_PORT when --port has no value', () => {
      const result = parseCLIArgs(['serve', '--port']);
      assert.equal(result.port, DEFAULT_PORT);
    });

    it('should accept --port before command', () => {
      const result = parseCLIArgs(['--port', '3000', 'serve']);
      assert.equal(result.port, 3000);
      assert.equal(result.command, '--port');
    });

    it('should handle port 0', () => {
      const result = parseCLIArgs(['serve', '--port', '0']);
      assert.equal(result.port, 0);
    });

    it('should handle negative port as a valid finite number', () => {
      const result = parseCLIArgs(['serve', '--port', '-1']);
      assert.equal(result.port, -1);
    });

    it('should fall back to DEFAULT_PORT for Infinity', () => {
      const result = parseCLIArgs(['serve', '--port', 'Infinity']);
      assert.equal(result.port, DEFAULT_PORT);
    });
  });

  describe('help flag', () => {
    it('should detect --help', () => {
      const result = parseCLIArgs(['--help']);
      assert.equal(result.help, true);
    });

    it('should detect -h', () => {
      const result = parseCLIArgs(['-h']);
      assert.equal(result.help, true);
    });

    it('should be false when not present', () => {
      const result = parseCLIArgs(['serve']);
      assert.equal(result.help, false);
    });

    it('should detect --help alongside command', () => {
      const result = parseCLIArgs(['serve', '--help']);
      assert.equal(result.help, true);
      assert.equal(result.command, 'serve');
    });
  });

  describe('version flag', () => {
    it('should detect --version', () => {
      const result = parseCLIArgs(['--version']);
      assert.equal(result.version, true);
    });

    it('should detect -v', () => {
      const result = parseCLIArgs(['-v']);
      assert.equal(result.version, true);
    });

    it('should be false when not present', () => {
      const result = parseCLIArgs(['serve']);
      assert.equal(result.version, false);
    });
  });

  describe('combined flags', () => {
    it('should parse command + port + help', () => {
      const result = parseCLIArgs(['relay', '--port', '5555', '--help']);
      assert.equal(result.command, 'relay');
      assert.equal(result.port, 5555);
      assert.equal(result.help, true);
    });

    it('should parse command + version', () => {
      const result = parseCLIArgs(['serve', '-v']);
      assert.equal(result.command, 'serve');
      assert.equal(result.version, true);
    });

    it('should handle empty array', () => {
      const result = parseCLIArgs([]);
      assert.equal(result.command, undefined);
      assert.equal(result.port, DEFAULT_PORT);
      assert.equal(result.help, false);
      assert.equal(result.version, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Command dispatch routing
// ---------------------------------------------------------------------------

describe('Command dispatch logic', () => {
  function getDispatchAction(command: string | undefined): string {
    switch (command) {
      case 'relay':
        return 'start-relay';
      case 'serve':
        return 'start-mcp';
      default:
        if (command) return 'unknown-command';
        return 'no-command';
    }
  }

  it('should route "relay" to start-relay', () => {
    assert.equal(getDispatchAction('relay'), 'start-relay');
  });

  it('should route "serve" to start-mcp', () => {
    assert.equal(getDispatchAction('serve'), 'start-mcp');
  });

  it('should route undefined to no-command', () => {
    assert.equal(getDispatchAction(undefined), 'no-command');
  });

  it('should route unknown command to unknown-command', () => {
    assert.equal(getDispatchAction('foo'), 'unknown-command');
  });
});

// ---------------------------------------------------------------------------
// Version banner suppression (Fix #5)
// ---------------------------------------------------------------------------

describe('Version banner suppression', () => {
  function shouldPrintBanner(command: string | undefined): boolean {
    return command !== 'serve' && command !== 'relay';
  }

  it('should suppress banner for "serve" command', () => {
    assert.equal(shouldPrintBanner('serve'), false);
  });

  it('should suppress banner for "relay" command', () => {
    assert.equal(shouldPrintBanner('relay'), false);
  });

  it('should print banner for unknown command', () => {
    assert.equal(shouldPrintBanner('foo'), true);
  });

  it('should print banner when no command', () => {
    assert.equal(shouldPrintBanner(undefined), true);
  });

  it('should print banner for --help (command is --help)', () => {
    assert.equal(shouldPrintBanner('--help'), true);
  });
});
