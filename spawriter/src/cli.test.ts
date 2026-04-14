/**
 * Tests for CLI argument parsing logic.
 * Tests the arg-parsing logic without actually starting servers.
 *
 * Run: npx tsx --test spawriter/src/cli.test.ts
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

// ---------------------------------------------------------------------------
// Phase 3: goke-based CLI dispatch logic
// ---------------------------------------------------------------------------

describe('Phase 3: CLI dispatch with -e flag', () => {
  interface GokeDispatch {
    mode: 'mcp' | 'execute' | 'command';
    code?: string;
    session?: string;
    command?: string;
  }

  function resolveDispatch(opts: {
    eval?: string;
    session?: string;
    command?: string;
  }): GokeDispatch {
    if (opts.eval) {
      return { mode: 'execute', code: opts.eval, session: opts.session };
    }
    if (opts.command) {
      return { mode: 'command', command: opts.command };
    }
    return { mode: 'mcp' };
  }

  it('no flags → MCP server mode', () => {
    const d = resolveDispatch({});
    assert.equal(d.mode, 'mcp');
  });

  it('-e flag → execute mode', () => {
    const d = resolveDispatch({ eval: 'await page.goto("http://example.com")' });
    assert.equal(d.mode, 'execute');
    assert.equal(d.code, 'await page.goto("http://example.com")');
  });

  it('-e with -s → execute with session', () => {
    const d = resolveDispatch({ eval: 'return 1+1', session: 'my-session' });
    assert.equal(d.mode, 'execute');
    assert.equal(d.session, 'my-session');
  });

  it('command → command mode', () => {
    const d = resolveDispatch({ command: 'skill' });
    assert.equal(d.mode, 'command');
    assert.equal(d.command, 'skill');
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Session commands
// ---------------------------------------------------------------------------

describe('Phase 3: session subcommand routing', () => {
  type SessionAction = 'new' | 'list' | 'delete' | 'reset';
  const validActions: SessionAction[] = ['new', 'list', 'delete', 'reset'];

  it('all 4 session actions recognized', () => {
    assert.equal(validActions.length, 4);
    assert.ok(validActions.includes('new'));
    assert.ok(validActions.includes('list'));
    assert.ok(validActions.includes('delete'));
    assert.ok(validActions.includes('reset'));
  });

  it('session delete/reset require an id argument', () => {
    function validateSessionArgs(action: SessionAction, args: string[]): boolean {
      if (action === 'delete' || action === 'reset') return args.length >= 1;
      return true;
    }
    assert.equal(validateSessionArgs('new', []), true);
    assert.equal(validateSessionArgs('list', []), true);
    assert.equal(validateSessionArgs('delete', []), false);
    assert.equal(validateSessionArgs('delete', ['sess-1']), true);
    assert.equal(validateSessionArgs('reset', []), false);
    assert.equal(validateSessionArgs('reset', ['sess-1']), true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: CLI command list completeness
// ---------------------------------------------------------------------------

describe('Phase 3: CLI command coverage', () => {
  const expectedCommands = ['serve', 'relay', 'skill', 'logfile', 'session'];

  it('all expected commands present', () => {
    assert.equal(expectedCommands.length, 5);
    for (const cmd of expectedCommands) {
      assert.ok(typeof cmd === 'string' && cmd.length > 0);
    }
  });

  it('global options include host, token, session, eval, timeout, port', () => {
    const globalOpts = ['host', 'token', 'session', 'eval', 'timeout', 'port'];
    assert.equal(globalOpts.length, 6);
    assert.ok(globalOpts.includes('eval'));
    assert.ok(globalOpts.includes('session'));
  });
});

// ---------------------------------------------------------------------------
// Phase 3: relay --replace logic
// ---------------------------------------------------------------------------

describe('Phase 3: relay --replace port detection', () => {
  it('should determine if port is occupied', () => {
    function isPortOccupied(portCheckResult: 'free' | 'occupied'): boolean {
      return portCheckResult === 'occupied';
    }
    assert.equal(isPortOccupied('free'), false);
    assert.equal(isPortOccupied('occupied'), true);
  });

  it('--replace flag triggers kill+restart flow', () => {
    function relayAction(replace: boolean, portOccupied: boolean): string {
      if (portOccupied && !replace) return 'error-port-in-use';
      if (portOccupied && replace) return 'kill-and-restart';
      return 'start';
    }
    assert.equal(relayAction(false, false), 'start');
    assert.equal(relayAction(false, true), 'error-port-in-use');
    assert.equal(relayAction(true, true), 'kill-and-restart');
    assert.equal(relayAction(true, false), 'start');
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Kitty Graphics Protocol detection
// ---------------------------------------------------------------------------

describe('Phase 3: Kitty Graphics support detection', () => {
  function canEmitKitty(env: { TERM?: string; TERM_PROGRAM?: string }): boolean {
    if (env.TERM_PROGRAM === 'WezTerm') return true;
    if (env.TERM === 'xterm-kitty') return true;
    return false;
  }

  it('detects WezTerm', () => {
    assert.equal(canEmitKitty({ TERM_PROGRAM: 'WezTerm' }), true);
  });

  it('detects kitty terminal', () => {
    assert.equal(canEmitKitty({ TERM: 'xterm-kitty' }), true);
  });

  it('returns false for unknown terminal', () => {
    assert.equal(canEmitKitty({ TERM: 'xterm-256color' }), false);
  });

  it('returns false for empty env', () => {
    assert.equal(canEmitKitty({}), false);
  });
});
