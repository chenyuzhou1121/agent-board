#!/usr/bin/env node
/** Store local resource registrations and route messages between sessions. */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const HOUR = 3600000;
const HANDLE = /^[a-z0-9][a-z0-9_.-]*$/;
const RESERVED = new Set(['all', 'user', 'board']);
const unique = values => [...new Set(values)];
const hostOf = target => target.split(':')[0];
const overlaps = (a, b) => a === b || (!a.includes(':') && a === hostOf(b)) || (!b.includes(':') && b === hostOf(a));
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
// Generated reply commands must preserve paths containing spaces or shell metacharacters.
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const formatTime = value => value ? new Date(value).toLocaleString('en-GB', { hour12: false }) : 'unspecified';
const expandPath = (value, base) => path.resolve(base, value === '~' ? HOME : value.startsWith('~/') ? path.join(HOME, value.slice(2)) : value);
const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * Parse an array of CLI tokens into { options, positionals }.
 * Options may appear anywhere; -- makes all remaining tokens positional.
 * Unknown options and missing option values throw an Error.
 */
export function parseArguments(args) {
  const options = {}, positionals = [];
  const flags = new Set(['help', 'share', 'all', 'push', 'force', 'quiet']);
  const values = new Set(['config', 'as', 'note', 'until', 'mem', 'n', 'port']);
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (value === '-h') { options.help = true; continue; }
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const equal = value.indexOf('=');
    const key = value.slice(2, equal < 0 ? undefined : equal);
    if (flags.has(key)) {
      if (equal >= 0) throw new Error(`--${key} takes no value`);
      options[key] = true;
    } else if (values.has(key)) {
      const next = equal < 0 ? args[++i] : value.slice(equal + 1);
      if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value`);
      options[key] = next;
    } else throw new Error(`Unknown option: --${key}. Use -- before message text containing options.`);
  }
  return { options, positionals };
}

/**
 * Read and normalize JSON configuration, returning paths, machines and settings.
 * An optional filename overrides BOARD_CONFIG and the default home config path.
 * Relative paths use the config directory; a missing default config uses defaults.
 * Invalid settings or a missing explicitly selected file throw an Error.
 */
export function readConfig(filename) {
  const selected = filename || process.env.BOARD_CONFIG;
  const configPath = expandPath(selected || '~/.agent-board/config.json', process.cwd());
  const explicit = Boolean(selected);
  let input = {};
  if (fs.existsSync(configPath)) input = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  else if (explicit) throw new Error(`Config file not found: ${configPath}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be a JSON object');
  const base = path.dirname(configPath);
  const sessions = input.sessions || {};
  const directories = key => {
    const list = sessions[key] || [];
    if (!Array.isArray(list) || list.some(value => typeof value !== 'string' || !value)) throw new Error(`${key} must be an array of paths`);
    return unique(list.map(value => expandPath(value, base)));
  };
  const positive = (value, fallback, name) => {
    const result = value ?? fallback;
    if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0) throw new Error(`${name} must be positive`);
    return result;
  };
  const httpUrl = value => {
    if (!value) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Monitor URLs must use HTTP(S) without credentials');
    return url.href;
  };
  const machines = input.machines || {};
  if (typeof machines !== 'object' || Array.isArray(machines)) throw new Error('machines must be an object');
  for (const [name, machine] of Object.entries(machines)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !machine || typeof machine !== 'object') throw new Error('Invalid machine entry');
    if (machine.gpus != null && (!Array.isArray(machine.gpus) || machine.gpus.some(gpu => !Number.isInteger(gpu) || gpu < 0))) throw new Error(`Invalid GPU indices for ${name}`);
    machine.directUrl = httpUrl(machine.directUrl);
  }
  const watch = {};
  for (const [target, rule] of Object.entries(input.watch || {})) {
    if (!/^[a-z][a-z0-9_-]*:\d+$/.test(target) || !rule || !Number.isFinite(rule.hotCelsius)) throw new Error('Invalid watch rule');
    // Watch keys and command-line claims must address the same numeric GPU index.
    watch[expandTargets([target])[0]] = rule;
  }
  const port = input.web?.port ?? 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('web.port must be an integer from 1 to 65535');
  const minimumGapMinutes = positive(input.heat?.minimumGapMinutes, 3, 'minimumGapMinutes');
  const maximumGapMinutes = positive(input.heat?.maximumGapMinutes, 15, 'maximumGapMinutes');
  if (minimumGapMinutes > maximumGapMinutes) throw new Error('minimumGapMinutes must not exceed maximumGapMinutes');
  return {
    configPath,
    database: expandPath(input.database || '~/.agent-board/board.db', base),
    monitorUrl: httpUrl(input.monitorUrl), machines, watch, port,
    sessions: {
      claudeDirectories: directories('claudeDirectories'),
      codexDirectories: directories('codexDirectories'),
      codexBinary: sessions.codexBinary ? (sessions.codexBinary.includes('/') ? expandPath(sessions.codexBinary, base) : sessions.codexBinary) : 'codex',
      recentMinutes: positive(sessions.recentMinutes, 30, 'recentMinutes'),
      lookbackDays: positive(sessions.lookbackDays, 14, 'lookbackDays'),
      queueHours: positive(sessions.queueHours, 24, 'queueHours'),
    },
    heat: {
      minimumGapMinutes,
      maximumGapMinutes,
      cooldownMinutes: positive(input.heat?.cooldownMinutes, 60, 'cooldownMinutes'),
    },
  };
}

/** Return an epoch time in milliseconds, or null for an omitted estimate. */
function parseTime(value) {
  if (!value) return null;
  const relative = value.match(/^\+(\d+(?:\.\d+)?)([mhd])$/);
  if (relative) return Date.now() + Number(relative[1]) * { m: 60000, h: HOUR, d: 24 * HOUR }[relative[2]];
  const clock = value.match(/^(\d{1,2}):(\d{2})$/);
  if (clock && +clock[1] < 24 && +clock[2] < 60) {
    const date = new Date();
    date.setHours(+clock[1], +clock[2], 0, 0);
    // A clock-only estimate refers to the next occurrence in local time.
    if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < Date.now()) throw new Error('Use a future time: +6h, +90m, 18:00, or an ISO timestamp');
  return time;
}

/** Expand machine[:GPU,GPU] strings into unique, normalized resource targets. */
function expandTargets(values) {
  return unique(values.flatMap(value => {
    const target = value.toLowerCase();
    if (!/^[a-z][a-z0-9_-]*(:\d+(,\d+)*)?$/.test(target)) throw new Error(`Invalid target: ${value}. Use compute-a or compute-a:0,1`);
    const [host, gpus] = target.split(':');
    return gpus ? gpus.split(',').map(gpu => `${host}:${Number(gpu)}`) : [host];
  }));
}

/** Read local process ancestry and terminal details; return an empty Map on failure. */
function processTable() {
  const rows = new Map();
  try {
    const output = execFileSync('ps', ['-ax', '-ww', '-o', 'pid=,ppid=,tty=,comm=,args='], { encoding: 'utf8', timeout: 3000 });
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (match) rows.set(+match[1], { parent: +match[2], tty: match[3], executable: path.basename(match[4]), command: match[5] });
    }
  } catch {}
  return rows;
}

/** Return why socket delivery is blocked, or null for an interactive CLI session. */
function socketBlock(session, process) {
  if (!session.socket) return 'No message socket';
  if (session.entrypoint && session.entrypoint !== 'cli') return 'Non-CLI session';
  if (['daemon', 'daemon-worker'].includes(session.kind)) return 'Background session';
  if (!process || ['??', '?', '-'].includes(process.tty)) return 'No interactive terminal';
  if (/(^|\s)(--print|--init-only|--sdk-url)(\s|=|$)|(^|\s)-p(\s|$)/.test(process.command)) return 'Noninteractive process';
  return null;
}

/** Write one newline-delimited user message to a socket; resolve whether the write completed. */
function ringSocket(socket, text) {
  return new Promise(resolve => {
    const connection = net.createConnection(socket);
    const finish = ok => { connection.destroy(); resolve(ok); };
    connection.setTimeout(3000, () => finish(false));
    connection.on('error', () => finish(false));
    connection.on('connect', () => connection.end(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n', () => finish(true)));
  });
}

/**
 * Manage SQLite state, session discovery, advisory claims and message delivery.
 * Identity arguments come from identity(); options use parseArguments() key names.
 * Stored timestamps are epoch milliseconds; targets are machine or machine:GPU strings.
 */
export class Board {
  /** Accept normalized readConfig output and an open DatabaseSync; create its tables. */
  constructor(config, database) {
    this.config = config;
    this.db = database;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agents(
        handle TEXT PRIMARY KEY, runtime TEXT, session_id TEXT, session_name TEXT,
        cwd TEXT, home TEXT, note TEXT, last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY, owner TEXT, ts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS claims(
        id INTEGER PRIMARY KEY, handle TEXT, target TEXT, mem TEXT, share INTEGER,
        note TEXT, since INTEGER, until INTEGER, ended_at INTEGER, end_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS wants(id INTEGER PRIMARY KEY, handle TEXT, targets TEXT, note TEXT, since INTEGER, ended_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, ts INTEGER, sender TEXT, recipient TEXT, body TEXT, delivery TEXT);
      CREATE TABLE IF NOT EXISTS reads(msg_id INTEGER, handle TEXT, PRIMARY KEY(msg_id,handle));
      CREATE TABLE IF NOT EXISTS asks(
        id INTEGER PRIMARY KEY, ts INTEGER, handle TEXT, host TEXT, body TEXT,
        status TEXT, decided_at INTEGER, decision_note TEXT
      );
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts INTEGER, handle TEXT, text TEXT);
      CREATE TABLE IF NOT EXISTS heat_samples(target TEXT PRIMARY KEY, temperature REAL, ts INTEGER);
      CREATE TABLE IF NOT EXISTS nudges(target TEXT, handle TEXT, ts INTEGER, PRIMARY KEY(target,handle));
    `);
    // Serialize schema inspection and updates across concurrent board processes.
    this.transaction(() => {
      if (!this.all('PRAGMA table_info(aliases)').some(column => column.name === 'ts')) {
        this.db.exec('ALTER TABLE aliases ADD COLUMN ts INTEGER NOT NULL DEFAULT 0');
      }
    });
    this.discovered = null;
    this.processes = null;
  }

  /** Return all SQL rows, binding positional values and converting undefined to null. */
  all(sql, ...values) {
    return this.db.prepare(sql).all(...values.map(value => value ?? null));
  }
  /** Return the first SQL row or undefined, using the same bindings as all(). */
  one(sql, ...values) {
    return this.db.prepare(sql).get(...values.map(value => value ?? null));
  }
  /** Execute SQL with positional bindings; return changes and lastInsertRowid. */
  run(sql, ...values) {
    return this.db.prepare(sql).run(...values.map(value => value ?? null));
  }
  /** Run a synchronous callback in a write transaction; return its result or roll back. */
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Close the database owned by this board. */
  close() {
    this.db.close();
  }
  /** Append event text for a handle with the current epoch time in milliseconds. */
  event(handle, text) {
    this.run('INSERT INTO events(ts,handle,text) VALUES(?,?,?)', Date.now(), handle, text);
  }
  /** Return active claim rows, including claims past their estimated end time. */
  claims() {
    return this.all('SELECT * FROM claims WHERE ended_at IS NULL ORDER BY target,since');
  }
  /** Return active wait rows with targets decoded into arrays of resource strings. */
  wants() {
    return this.all('SELECT * FROM wants WHERE ended_at IS NULL ORDER BY since')
      .map(row => ({ ...row, targets: JSON.parse(row.targets) }));
  }
  /** Return unread direct mail plus other senders' broadcasts from the last seven days. */
  unread(handle) {
    return this.all(`SELECT m.* FROM messages m WHERE (m.recipient=? OR (m.recipient='all' AND m.ts>? AND m.sender<>?))
      AND NOT EXISTS(SELECT 1 FROM reads r WHERE r.msg_id=m.id AND r.handle=?) ORDER BY m.id`, handle, Date.now() - 7 * 24 * HOUR, handle, handle);
  }
  /** Mark positive integer IDs read for a handle, only for its direct or broadcast mail. */
  markRead(handle, ids) {
    this.transaction(() => {
      for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid message ID');
        this.run(`INSERT OR IGNORE INTO reads(msg_id,handle) SELECT id,? FROM messages WHERE id=? AND (recipient=? OR recipient='all')`, handle, id, handle);
      }
    });
  }

  /** Return cached session records discovered under the configured runtime roots. */
  sessions() {
    if (this.discovered) return this.discovered;
    const sessions = [];
    const listing = directory => { try { return fs.readdirSync(directory); } catch { return []; } };
    for (const root of this.config.sessions.claudeDirectories) {
      const directory = path.join(root, 'sessions');
      for (const file of listing(directory).filter(file => file.endsWith('.json'))) {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
          if (!Number.isInteger(entry.pid) || entry.pid <= 0 || !entry.sessionId || !isAlive(entry.pid)) continue;
          if (sessions.some(session => session.id === entry.sessionId)) continue;
          sessions.push({ runtime: 'claude', id: entry.sessionId, pid: entry.pid, name: entry.name || null,
            cwd: entry.cwd || null, socket: entry.messagingSocketPath || null, status: entry.status || null,
            kind: entry.kind, entrypoint: entry.entrypoint, home: root, updated: entry.updatedAt || null });
        } catch {}
      }
    }
    for (const root of this.config.sessions.codexDirectories) {
      for (let day = 0; day < this.config.sessions.lookbackDays; day++) {
        const date = new Date(Date.now() - day * 24 * HOUR);
        const directory = path.join(root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        for (const file of listing(directory).filter(file => file.endsWith('.jsonl'))) {
          let descriptor;
          try {
            const filename = path.join(directory, file);
            const modified = fs.statSync(filename).mtimeMs;
            if (Date.now() - modified > Math.max(this.config.sessions.queueHours * HOUR, this.config.sessions.recentMinutes * 60000)) continue;
            descriptor = fs.openSync(filename, 'r');
            // Only the first JSONL record is needed to identify a thread.
            const buffer = Buffer.alloc(65536);
            const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
            const header = JSON.parse(buffer.subarray(0, bytes).toString('utf8').split('\n')[0]);
            const entry = header.payload;
            if (header.type !== 'session_meta' || !entry?.id || sessions.some(session => session.id === entry.id)) continue;
            sessions.push({ runtime: 'codex', id: entry.id, cwd: entry.cwd || null, name: null, home: root,
              updated: modified, recent: Date.now() - modified <= this.config.sessions.recentMinutes * 60000 });
          } catch {} finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
          }
        }
      }
    }
    return (this.discovered = sessions);
  }

  /** Return whether an agent row has a discovered session within its queue window. */
  reachable(agent) {
    const session = this.sessions().find(session => session.id === agent?.session_id);
    return Boolean(session && (session.runtime !== 'codex' || Date.now() - session.updated <= this.config.sessions.queueHours * HOUR));
  }
  /** Return a handle for a session, reusing its binding or an inactive directory peer. */
  nameFor(session) {
    const bound = this.one('SELECT handle FROM agents WHERE session_id=?', session.id);
    if (bound) return bound.handle;
    const peers = this.sessions().filter(peer => peer.id !== session.id);
    const sameDirectory = peers.some(peer => peer.cwd === session.cwd && peer.runtime === session.runtime);
    // Reuse a directory's old handle only when no concurrent peer makes it ambiguous.
    const old = !sameDirectory && session.cwd && this.all('SELECT * FROM agents WHERE cwd=? AND runtime=? ORDER BY last_seen DESC', session.cwd, session.runtime).find(agent => !this.reachable(agent));
    if (old) return old.handle;
    const base = slug(path.basename(session.cwd || 'session')) || 'session';
    const name = slug(session.name);
    const candidates = [
      peers.some(peer => slug(path.basename(peer.cwd || 'session')) === base) ? '' : base,
      name && !peers.some(peer => slug(peer.name) === name) ? name : '',
      `${base}-${slug(session.id).slice(-8)}`,
    ];
    for (const candidate of candidates) {
      if (candidate && !RESERVED.has(candidate) && !this.one('SELECT 1 FROM agents WHERE handle=?', candidate)) return candidate;
    }
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base}-${slug(session.id).slice(-8)}-${suffix}`;
      if (!this.one('SELECT 1 FROM agents WHERE handle=?', candidate)) return candidate;
    }
  }
  /** Return caller identity from process ancestry, runtime variables and optional as. */
  identity(options = {}) {
    const sessions = this.sessions();
    const processes = this.processes ??= processTable();
    let runtime = null, session = null;
    for (let pid = process.pid, depth = 0; depth < 64 && pid > 1; depth++) {
      session = sessions.find(candidate => candidate.runtime === 'claude' && candidate.pid === pid);
      if (session) {
        runtime = 'claude';
        break;
      }
      const process = processes.get(pid);
      if (!process) break;
      if (process.executable === 'codex') {
        runtime = 'codex';
        break;
      }
      pid = process.parent;
      if (pid <= 1) runtime = 'shell';
    }
    if (!runtime) runtime = process.env.CODEX_THREAD_ID ? 'codex' : process.env.CLAUDE_CODE_MESSAGING_SOCKET ? 'claude' : 'shell';
    if (runtime === 'codex') session = sessions.find(candidate => candidate.id === process.env.CODEX_THREAD_ID);
    if (runtime === 'claude' && !session) session = sessions.find(candidate => candidate.socket === process.env.CLAUDE_CODE_MESSAGING_SOCKET);
    const id = session?.id || (runtime === 'codex' ? process.env.CODEX_THREAD_ID : null);
    const cwd = session?.cwd || process.cwd();
    const base = slug(path.basename(cwd));
    const self = id ? this.nameFor({ ...session, id, cwd, runtime }) : base && !RESERVED.has(base) ? base : 'session';
    const handle = (options.as || process.env.BOARD_AS || self).toLowerCase();
    if (!HANDLE.test(handle) || (RESERVED.has(handle) && handle !== 'user')) throw new Error('Use a nonreserved lowercase handle containing letters, digits, dots, dashes or underscores');
    return { handle, self, runtime, id, cwd, socket: session?.socket || null, name: session?.name || null,
      home: runtime === 'codex' ? process.env.CODEX_HOME || session?.home || null : session?.home || null,
      oneOff: Boolean(options.as || process.env.BOARD_AS) };
  }
  /** Upsert an identity and optional note; reject a handle bound to another live session. */
  touchRow(me, note) {
    const holder = this.one('SELECT * FROM agents WHERE handle=?', me.handle);
    if (holder && holder.session_id !== me.id && this.reachable(holder)) throw new Error(`Handle is in use: ${me.handle}`);
    if (me.id) this.run('UPDATE agents SET session_id=NULL WHERE session_id=? AND handle<>?', me.id, me.handle);
    this.run(`INSERT INTO agents(handle,runtime,session_id,session_name,cwd,home,note,last_seen) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(handle) DO UPDATE SET runtime=excluded.runtime,session_id=excluded.session_id,session_name=excluded.session_name,
      cwd=excluded.cwd,home=excluded.home,note=COALESCE(excluded.note,agents.note),last_seen=excluded.last_seen`,
      me.handle, me.runtime, me.id, me.name, me.cwd, me.home, note, Date.now());
  }
  /** Refresh identity state and a one-off alias; skip the reserved user identity. */
  touch(me, note) {
    if (me.handle === 'user') return;
    this.transaction(() => {
      const identity = me.oneOff && me.id ? { ...me, handle: me.self } : me;
      this.touchRow(identity, note);
      if (me.oneOff && me.id && me.runtime !== 'shell' && me.self !== me.handle && !RESERVED.has(me.handle)) {
        this.run('INSERT INTO aliases(alias,owner,ts) VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET owner=excluded.owner,ts=excluded.ts', me.handle, me.self, Date.now());
      }
    });
  }
  /** Register or rename identity using as and note options; return confirmation text. */
  register(me, options) {
    const handle = (options.as || me.self).toLowerCase();
    if (!HANDLE.test(handle) || RESERVED.has(handle)) throw new Error('Invalid or reserved handle');
    const holder = this.one('SELECT * FROM agents WHERE handle=?', handle);
    if (holder && holder.session_id !== me.id && this.reachable(holder)) throw new Error(`Handle is in use: ${handle}`);
    this.transaction(() => {
      if (handle !== me.self && me.id && this.one('SELECT 1 FROM agents WHERE handle=? AND session_id=?', me.self, me.id)) {
        // Move active ownership and unread state together when a session is renamed.
        this.run('UPDATE messages SET recipient=? WHERE recipient=?', handle, me.self);
        this.run('UPDATE claims SET handle=? WHERE handle=? AND ended_at IS NULL', handle, me.self);
        this.run('UPDATE wants SET handle=? WHERE handle=? AND ended_at IS NULL', handle, me.self);
        this.run('UPDATE asks SET handle=? WHERE handle=?', handle, me.self);
        this.run('INSERT INTO nudges(target,handle,ts) SELECT target,?,ts FROM nudges WHERE handle=? ON CONFLICT(target,handle) DO UPDATE SET ts=MAX(nudges.ts,excluded.ts)', handle, me.self);
        this.run('DELETE FROM nudges WHERE handle=?', me.self);
        this.run('UPDATE aliases SET owner=? WHERE owner=?', handle, me.self);
        this.run('INSERT OR IGNORE INTO reads(msg_id,handle) SELECT msg_id,? FROM reads WHERE handle=?', handle, me.self);
        this.run('DELETE FROM agents WHERE handle=?', me.self);
      }
      this.run('DELETE FROM aliases WHERE alias=?', handle);
      this.touchRow({ ...me, handle }, options.note);
      this.event(handle, 'Registered identity');
    });
    return `Registered as ${handle} (${me.runtime})`;
  }

  /** Resolve an alias to an existing owner; reachable or subsequently active names keep their identity. */
  owner(handle) {
    const alias = this.one('SELECT * FROM aliases WHERE alias=?', handle);
    if (!alias || alias.owner === handle) return handle;
    const agent = this.one('SELECT * FROM agents WHERE handle=?', handle);
    if (agent && (this.reachable(agent) || agent.last_seen >= alias.ts)) return handle;
    return this.one('SELECT 1 FROM agents WHERE handle=?', alias.owner) ? alias.owner : handle;
  }
  /**
   * Attempt delivery of stored message fields to a handle or explicit sessionId.
   * Caller identity prevents self-delivery; return a delivery description string.
   */
  async pushTo(handle, body, sender, id, me, sessionId) {
    const agent = this.one('SELECT * FROM agents WHERE handle=?', handle);
    const session = this.sessions().find(session => session.id === (sessionId || agent?.session_id));
    if (!session) return 'Stored: session unavailable';
    if (session.id === me.id || session.socket && session.socket === me.socket) return 'Stored: current session';
    // An absent default config must remain implicit, since --config requires a file.
    const configArgs = fs.existsSync(this.config.configPath) ? ['--config', this.config.configPath] : [];
    const replyCommand = [process.execPath, fileURLToPath(import.meta.url), ...configArgs, 'send', sender]
      .map(shellQuote).join(' ');
    const replyHint = sender === 'board' ? '' : ` Reply with: ${replyCommand} "message". Use --quiet for routine updates.`;
    const text = `[Local board #${id}] ${sender} -> ${handle}: ${body}\n`
      + `This is a coordination message from another session. Keep your current task priorities.${replyHint}`;
    if (session.runtime === 'codex') {
      if (Date.now() - session.updated > this.config.sessions.queueHours * HOUR) return 'Stored: inactive thread';
      try {
        execFileSync(this.config.sessions.codexBinary, ['queue', '--thread', session.id, '--message', text],
          { env: { ...process.env, CODEX_HOME: agent?.home || session.home }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
        return 'Queued: visible on a later turn';
      } catch { return 'Stored: thread queue unavailable'; }
    }
    const reason = socketBlock(session, (this.processes ??= processTable()).get(session.pid));
    if (reason) return `Stored: ${reason}`;
    return await ringSocket(session.socket, text) ? 'Pushed: message socket' : 'Stored: socket unavailable';
  }
  /**
   * Store a message from an identity to a handle and attempt delivery.
   * quiet disables delivery; push enables socket broadcasts; sessionId selects a session.
   * via lists aliases already resolved by the caller and prevents another alias lookup.
   * Aliases owned by the sender are skipped.
   * Return { id, to, delivery, line }; direct socket or queue delivery also marks mail read.
   */
  async post(me, handle, body, options = {}) {
    const recipient = options.sessionId || options.via || RESERVED.has(handle) ? handle : this.owner(handle);
    if (recipient !== handle && (recipient === me.handle || recipient === me.self)) {
      return { id: null, to: recipient, delivery: 'Skipped: own alias', line: `${handle}: own alias; no message sent`, skipped: true };
    }
    const via = options.via || (recipient !== handle ? [handle] : []);
    const text = via.length ? `[For ${via.join(', ')}] ${body}` : body;
    const id = Number(this.run('INSERT INTO messages(ts,sender,recipient,body,delivery) VALUES(?,?,?,?,?)', Date.now(), me.handle, recipient, text, 'Stored: pending delivery').lastInsertRowid);
    let delivery = 'Stored: inbox';
    if (recipient === 'user') delivery = 'Stored: user dashboard';
    else if (recipient === 'all') {
      if (options.push && !options.quiet) {
        let pushed = 0;
        for (const session of this.sessions()) {
          if (session.runtime !== 'claude' || session.id === me.id || session.socket === me.socket) continue;
          if (socketBlock(session, (this.processes ??= processTable()).get(session.pid))) continue;
          if (await ringSocket(session.socket, `[Local board #${id}] ${me.handle} -> all: ${text}\nCoordination message. Keep your current task priorities.`)) pushed++;
        }
        delivery = pushed ? `Pushed: ${pushed} sessions` : 'Stored: no interactive sessions';
      } else delivery = 'Stored: broadcast';
    } else if (options.quiet) delivery = 'Stored: quiet message';
    else delivery = await this.pushTo(recipient, text, me.handle, id, me, options.sessionId);
    this.run('UPDATE messages SET delivery=? WHERE id=?', delivery, id);
    if (recipient !== 'all' && (delivery.startsWith('Pushed:') || delivery.startsWith('Queued:'))) this.markRead(recipient, [id]);
    this.event(me.handle, `Message ${id} to ${recipient}: ${delivery}`);
    return { id, to: recipient, delivery, line: `${id} -> ${recipient}: ${delivery}` };
  }
  /**
   * Resolve a handle, session name, all, user or @machine and send nonempty text.
   * Merge aliases for the same recipient and omit the sender's own aliases.
   * Accept post options plus force for unknown handles; return an array of post results.
   */
  async sendMessage(me, to, body, options = {}) {
    if (typeof to !== 'string' || typeof body !== 'string' || !to.trim() || !body.trim()) throw new Error('Recipient and message are required');
    const target = to.toLowerCase().trim();
    let candidates;
    if (target.startsWith('@')) {
      candidates = unique(this.claims().filter(claim => hostOf(claim.target) === target.slice(1) && claim.handle !== me.handle).map(claim => claim.handle))
        .map(handle => ({ handle }));
    } else {
      const known = this.one('SELECT 1 FROM agents WHERE handle=?', target);
      const named = !known && !RESERVED.has(target) && this.sessions().find(session => session.name?.toLowerCase() === target || this.nameFor(session) === target);
      candidates = [{ handle: named ? this.nameFor(named) : target, sessionId: named?.id }];
    }
    const recipients = [];
    for (const candidate of candidates) {
      const handle = candidate.sessionId || RESERVED.has(candidate.handle) ? candidate.handle : this.owner(candidate.handle);
      const alias = handle !== candidate.handle;
      if (alias && (handle === me.handle || handle === me.self)) continue;
      if (!alias && target.startsWith('@') && handle === me.self) continue;
      const previous = recipients.find(recipient => recipient.handle === handle && !recipient.sessionId && !candidate.sessionId);
      if (previous) {
        if (alias) (previous.via ??= []).push(candidate.handle);
        continue;
      }
      recipients.push({ ...candidate, handle, via: alias ? [candidate.handle] : undefined });
    }
    if (!recipients.length) throw new Error('No other recipients');
    const results = [];
    for (const recipient of recipients) {
      if (!['all', 'user'].includes(recipient.handle) && !HANDLE.test(recipient.handle)) throw new Error('Invalid recipient handle');
      if (!options.force && !recipient.sessionId && !['all', 'user'].includes(recipient.handle) && !this.one('SELECT 1 FROM agents WHERE handle=?', recipient.handle)) {
        throw new Error(`Unknown handle: ${recipient.handle}. Use who, or --force to leave a message for a future registration`);
      }
      results.push(await this.post(me, recipient.handle, body.trim(), { ...options, sessionId: recipient.sessionId, via: recipient.via }));
    }
    return results;
  }

  /** Return monitor readings keyed by machine:GPU, or null when none are usable. */
  async liveGpus() {
    const live = {};
    const read = async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('Monitor unavailable');
      return response.json();
    };
    const add = (name, node) => {
      if (!node || node.online === false || node.stale || node.meta?.stale) return;
      for (const gpu of node.gpus || []) {
        if (!Number.isInteger(Number(gpu.index)) || Number(gpu.index) < 0) continue;
        const used = Number(gpu.mem_used), total = Number(gpu.mem_total), util = Number(gpu.util);
        if (![used, total, util].every(Number.isFinite) || total <= 0) continue;
        // Match the numeric GPU indices produced by expandTargets().
        live[`${name}:${Number(gpu.index)}`] = { used, total, util, temp: gpu.temp == null ? null : Number(gpu.temp) };
      }
    };
    if (this.config.monitorUrl) {
      try {
        const nodes = await read(this.config.monitorUrl);
        for (const [name, machine] of Object.entries(this.config.machines)) add(name, nodes.find(node => node.name === machine.monitorName));
      } catch {}
    }
    await Promise.all(Object.entries(this.config.machines).map(async ([name, machine]) => {
      if (!machine.directUrl || Object.keys(live).some(target => hostOf(target) === name)) return;
      try { add(name, await read(machine.directUrl)); } catch {}
    }));
    return Object.keys(live).length ? live : null;
  }
  /**
   * Record machine[:GPU,GPU] targets for an identity; return status lines.
   * Options until, mem, share and note update metadata; claims do not expire or lock GPUs.
   */
  async claim(me, values, options) {
    if (!values.length) throw new Error('claim requires a machine or GPU target');
    const targets = expandTargets(values), until = parseTime(options.until);
    const lines = this.transaction(() => {
      const output = [];
      for (const target of targets) {
        const old = this.one('SELECT * FROM claims WHERE handle=? AND target=? AND ended_at IS NULL', me.handle, target);
        let id;
        if (old) {
          this.run('UPDATE claims SET until=COALESCE(?,until),mem=COALESCE(?,mem),share=?,note=COALESCE(?,note) WHERE id=?', until, options.mem, options.share ? 1 : old.share, options.note, old.id);
          id = old.id;
        } else id = Number(this.run('INSERT INTO claims(handle,target,mem,share,note,since,until) VALUES(?,?,?,?,?,?,?)', me.handle, target, options.mem, options.share ? 1 : 0, options.note, Date.now(), until).lastInsertRowid);
        output.push(`${id} ${target}: ${old ? 'updated' : 'claimed'} until ${formatTime(until || old?.until)}`);
        for (const other of this.claims().filter(claim => overlaps(claim.target, target) && this.owner(claim.handle) !== this.owner(me.handle))) output.push(`  Also registered: ${other.handle} (#${other.id}). Coordinate with send.`);
        if (this.config.machines[hostOf(target)]?.approval) {
          const request = this.one('SELECT * FROM asks WHERE handle=? AND host=? ORDER BY id DESC LIMIT 1', me.handle, hostOf(target));
          output.push(`  User approval required. Latest request: ${request ? `#${request.id} ${request.status}` : 'none; use ask'}`);
        }
        for (const [watched, rule] of Object.entries(this.config.watch)) if (overlaps(watched, target)) output.push(`  Watch ${watched}: ${rule.note || 'temperature alert'} at ${rule.hotCelsius} C`);
        this.event(me.handle, `Claimed ${target}`);
      }
      for (const want of this.wants().filter(want => want.handle === me.handle)) {
        if (want.targets.some(target => targets.some(claimed => overlaps(target, claimed)))) this.run('UPDATE wants SET ended_at=? WHERE id=?', Date.now(), want.id);
      }
      return output;
    });
    return lines;
  }
  /**
   * End claims by target, ID or all for an identity; return status lines.
   * force permits ending another holder's claim before its estimated end; notify holders and ready waits.
   */
  async release(me, values, options) {
    if (!values.length) throw new Error('release requires targets, claim IDs or all');
    const rows = this.transaction(() => {
      const claims = this.claims();
      const matches = claims.filter(claim => values.some(value => {
        if (/^#?\d+$/.test(value)) return claim.id === Number(value.replace('#', ''));
        if (this.owner(claim.handle) !== this.owner(me.handle)) return false;
        return value === 'all' || expandTargets([value]).some(target => target === claim.target || !target.includes(':') && hostOf(claim.target) === target);
      }));
      for (const claim of matches) {
        if (this.owner(claim.handle) !== this.owner(me.handle) && claim.until && claim.until > Date.now() && !options.force) throw new Error(`Claim ${claim.id} belongs to ${claim.handle}; use --force to remove its registration`);
      }
      for (const claim of matches) {
        this.run("UPDATE claims SET ended_at=?,end_reason='released' WHERE id=?", Date.now(), claim.id);
        this.event(me.handle, `Released claim ${claim.id} on ${claim.target}`);
      }
      return matches;
    });
    for (const claim of rows) {
      if (this.owner(claim.handle) !== this.owner(me.handle)) await this.post(me, claim.handle, `Your registration #${claim.id} on ${claim.target} was removed. Register again if still needed.`);
    }
    const ready = this.transaction(() => {
      const claims = this.claims();
      const wants = this.wants().filter(want => want.targets.some(target => rows.some(claim => overlaps(claim.target, target))) && want.targets.every(target => !claims.some(claim => overlaps(claim.target, target))));
      for (const want of wants) this.run('UPDATE wants SET ended_at=? WHERE id=?', Date.now(), want.id);
      return wants;
    });
    for (const want of ready) await this.post({ handle: 'board' }, want.handle, `No registrations remain on ${want.targets.join(', ')}. Your wait has ended; check actual GPU usage before claiming.`);
    return rows.length ? rows.map(claim => `${claim.id} ${claim.target}: released`) : ['No matching active claims'];
  }
  /** Register joint target availability interest with an optional note; return status lines. */
  async want(me, values, options) {
    if (!values.length) throw new Error('want requires a machine or GPU target');
    const targets = expandTargets(values).sort();
    const key = JSON.stringify(targets);
    const old = this.transaction(() => {
      const previous = this.one('SELECT * FROM wants WHERE handle=? AND targets=? AND ended_at IS NULL', me.handle, key);
      if (previous && Date.now() - previous.since < 2 * HOUR) {
        this.run('UPDATE wants SET note=COALESCE(?,note) WHERE id=?', options.note, previous.id);
        return previous;
      }
      if (previous) this.run('UPDATE wants SET note=COALESCE(?,note),since=? WHERE id=?', options.note, Date.now(), previous.id);
      else this.run('INSERT INTO wants(handle,targets,note,since) VALUES(?,?,?,?)', me.handle, key, options.note, Date.now());
      this.event(me.handle, `Waiting for ${targets.join(', ')}`);
      return null;
    });
    if (old) return ['Wait updated; holders were already notified'];
    const holders = unique(this.claims().filter(claim => targets.some(target => overlaps(claim.target, target))).map(claim => this.owner(claim.handle))).filter(handle => handle !== this.owner(me.handle));
    for (const holder of holders) await this.post(me, holder, `${me.handle} is waiting for ${targets.join(', ')} together.${options.note ? ' ' + options.note : ''} Please discuss sharing or timing.`, { via: [] });
    return [holders.length ? `Waiting; notified ${holders.join(', ')}` : 'No other registrations; check actual usage before claiming'];
  }
  /** Create or update a pending request from [machine, ...messageWords]; return its ID text. */
  ask(me, values) {
    const [target, ...words] = values;
    if (!target || !words.join(' ').trim()) throw new Error('Usage: ask <machine> "resources and reason"');
    const host = hostOf(expandTargets([target])[0]);
    const body = words.join(' ').trim();
    const id = this.transaction(() => {
      const old = this.one("SELECT * FROM asks WHERE handle=? AND host=? AND status='pending'", me.handle, host);
      if (old) {
        this.run('UPDATE asks SET body=?,ts=? WHERE id=?', body, Date.now(), old.id);
        return old.id;
      }
      return Number(this.run("INSERT INTO asks(ts,handle,host,body,status) VALUES(?,?,?,?,'pending')", Date.now(), me.handle, host, body).lastInsertRowid);
    });
    this.event(me.handle, `Requested approval for ${host}`);
    return `Request ${id} submitted to the user`;
  }
  /** Record approved or denied for an integer request ID; notify its requester and return text. */
  async decide(me, id, status, note = '') {
    if (!Number.isSafeInteger(id) || !['approved', 'denied'].includes(status)) throw new Error('Invalid request ID or decision');
    const request = this.transaction(() => {
      const row = this.one('SELECT * FROM asks WHERE id=?', id);
      if (!row) throw new Error('Request not found');
      this.run('UPDATE asks SET status=?,decided_at=?,decision_note=? WHERE id=?', status, Date.now(), note, id);
      this.event('user', `${status} request ${id}`);
      return row;
    });
    await this.post({ handle: 'user', socket: me.socket }, request.handle, `Request #${id} for ${request.host} was ${status} by the user.${note ? ' ' + note : ''}`);
    return `Request ${id}: ${status}; notified ${request.handle}`;
  }
  /** Sample watch rules and notify claim holders after confirmed heat; return status lines. */
  async heat(me) {
    const live = await this.liveGpus(), lines = [];
    for (const [target, rule] of Object.entries(this.config.watch)) {
      const temperature = live?.[target]?.temp;
      if (!Number.isFinite(temperature)) {
        lines.push(`${target}: temperature unavailable`);
        continue;
      }
      const confirmed = this.transaction(() => {
        const previous = this.one('SELECT * FROM heat_samples WHERE target=?', target);
        const gap = previous ? Date.now() - previous.ts : Infinity;
        // Ignore repeated hot samples taken too soon; a cold sample resets confirmation immediately.
        if (previous?.temperature >= rule.hotCelsius && temperature >= rule.hotCelsius && gap < this.config.heat.minimumGapMinutes * 60000) return false;
        this.run('INSERT OR REPLACE INTO heat_samples(target,temperature,ts) VALUES(?,?,?)', target, temperature, Date.now());
        return temperature >= rule.hotCelsius && previous?.temperature >= rule.hotCelsius && gap <= this.config.heat.maximumGapMinutes * 60000;
      });
      lines.push(`${target}: ${temperature} C${temperature >= rule.hotCelsius ? confirmed ? ' alert confirmed' : ' awaiting another sample' : ''}`);
      if (!confirmed) continue;
      for (const handle of unique(this.claims().filter(claim => overlaps(claim.target, target)).map(claim => this.owner(claim.handle)))) {
        const due = this.transaction(() => {
          const previous = this.one('SELECT * FROM nudges WHERE target=? AND handle=?', target, handle);
          if (previous && Date.now() - previous.ts < this.config.heat.cooldownMinutes * 60000) return false;
          this.run('INSERT OR REPLACE INTO nudges(target,handle,ts) VALUES(?,?,?)', target, handle, Date.now());
          return true;
        });
        if (due) await this.post({ handle: 'board', socket: me.socket }, handle, `${target} is at ${temperature} C; alert threshold ${rule.hotCelsius} C. ${rule.note || 'Consider reducing load or pausing at a checkpoint.'}`, { via: [] });
      }
    }
    return lines.length ? lines : ['No watched GPUs configured'];
  }

  /** Return dashboard data, refreshing discovery and monitor state; timestamps use milliseconds. */
  async snapshot() {
    this.discovered = null;
    this.processes = null;
    const live = await this.liveGpus(), claims = this.claims(), wants = this.wants();
    const targets = [];
    for (const [name, machine] of Object.entries(this.config.machines)) targets.push(...(machine.gpus?.length ? machine.gpus.map(gpu => `${name}:${gpu}`) : [name]));
    targets.push(...Object.keys(live || {}), ...Object.keys(this.config.watch));
    for (const target of [...claims.map(claim => claim.target), ...wants.flatMap(want => want.targets)]) {
      if (!target.includes(':') && this.config.machines[target]?.gpus?.length) continue;
      targets.push(target);
    }
    const sessions = this.sessions().filter(session => session.runtime !== 'codex' || session.recent).map(session => ({
      handle: this.nameFor(session), runtime: session.runtime, name: session.name || session.id.slice(-8), cwd: session.cwd,
      status: session.status || (session.runtime === 'codex' ? 'Recently active' : ''),
      turn: session.runtime === 'claude' && !socketBlock(session, (this.processes ??= processTable()).get(session.pid)),
    }));
    return {
      now: Date.now(), monitor: Boolean(live),
      cards: unique(targets).map(target => ({ target, live: live?.[target] || null, watch: this.config.watch[target] || null,
        approval: Boolean(this.config.machines[hostOf(target)]?.approval),
        claims: claims.filter(claim => overlaps(claim.target, target)),
        wants: wants.filter(want => want.targets.some(value => overlaps(value, target))),
      })), sessions,
      handles: unique([...this.all('SELECT handle FROM agents ORDER BY last_seen DESC').map(agent => agent.handle), ...sessions.map(session => session.handle)]),
      agents: this.all('SELECT handle,runtime,note,last_seen FROM agents ORDER BY last_seen DESC'),
      messages: this.all(`SELECT m.*,EXISTS(SELECT 1 FROM reads r WHERE r.msg_id=m.id AND r.handle=m.recipient) AS read FROM messages m ORDER BY id DESC LIMIT 300`),
      userUnread: this.unread('user').filter(message => message.recipient === 'user').map(message => message.id),
      asks: this.all('SELECT * FROM asks ORDER BY id DESC LIMIT 100'),
      history: this.all('SELECT * FROM claims ORDER BY id DESC LIMIT 100'),
      events: this.all('SELECT * FROM events ORDER BY id DESC LIMIT 200'),
    };
  }
}

/** Return a Board for an optional config filename, creating its database and parent directory. */
export async function createBoard(filename) {
  const config = readConfig(filename);
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(config.database), { recursive: true });
  return new Board(config, new DatabaseSync(config.database));
}

/** CLI command and input reference, also returned by --help. */
export const HELP = `Local coordination board. Requires Node.js 22.13+; no packages to install.
Usage: node board.mjs [command] [--config path] [options]

Commands:
  status                         Show GPU registrations, sessions and pending requests
  hi [--as handle] [--note text]  Register or rename your identity
  who                            List registered identities and discovered sessions
  claim machine[:0,1] ...        Record resource use; repeated claims update it
    --until +6h|18:00|ISO-time --mem 24G --share --note text
  release target|ID|all ...      End registrations; --force for another holder's ID with a future end time
  want machine[:0,1] ...         Wait until all targets have no registrations; --note text
  send handle|all|@machine|user "message"
    --quiet                      Store without pushing to a session
    --push                       Push a broadcast to interactive socket sessions
    --force                      Allow a recipient who has not registered yet
  inbox [--all]                  Read messages and mark them read
  ask machine "resources and reason"
  asks                           List requests for user approval
  approve|deny ID [note]         Record the user's decision and notify the requester
  history [--n 40]               Show resource registrations
  log [--n 30]                   Show board events
  heat                           Sample watched GPUs; repeated hot samples notify holders
  web [--port 8790]             Serve the local dashboard in the foreground; Ctrl+C to stop

--as handle or BOARD_AS selects a one-off identity; hi --as renames it.
--config or BOARD_CONFIG selects JSON configuration (default ~/.agent-board/config.json).
Copy config.example.json and set machine URLs and session directories before use.
Relative paths resolve from the config directory; ~/ resolves from your home directory.
Without a config, machine monitoring and session discovery are disabled.
Claude roots hold JSON files under sessions; Codex roots hold JSONL files under sessions/YYYY/MM/DD.
monitorUrl returns an array of nodes {name,online,gpus}; directUrl returns one node.
GPU fields: index, util (percent), mem_used and mem_total (MiB), temp (Celsius).
Claims are advisory. They do not lock resources or control running processes.
Approval flags are reminders; only record decisions made by the user.
Use -- before message text that starts with --. Use --help for this help.
`;

/** Execute CLI tokens, print results and close the database; web keeps its server open. */
export async function main(args = process.argv.slice(2)) {
  const { options, positionals } = parseArguments(args);
  const command = positionals.shift() || 'status';
  if (options.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'web') {
    const { startServer } = await import('./web.mjs');
    await startServer(options.config, options.port);
    return;
  }
  const commands = new Set(['status', 'hi', 'who', 'claim', 'release', 'want', 'send', 'inbox', 'ask', 'asks', 'approve', 'deny', 'history', 'log', 'heat']);
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}. Use --help`);
  const board = await createBoard(options.config);
  try {
    const me = board.identity(options);
    if (command !== 'hi' && !['approve', 'deny', 'heat'].includes(command)) board.touch(me);
    let lines = [];
    switch (command) {
      case 'hi': lines = [board.register(me, options)]; break;
      case 'claim': lines = await board.claim(me, positionals, options); break;
      case 'release': lines = await board.release(me, positionals, options); break;
      case 'want': lines = await board.want(me, positionals, options); break;
      case 'ask': lines = [board.ask(me, positionals)]; break;
      case 'send': {
        const results = await board.sendMessage(me, positionals[0], positionals.slice(1).join(' '), options);
        lines = results.map(result => result.line);
        break;
      }
      case 'inbox': {
        const messages = options.all
          ? board.all("SELECT * FROM messages WHERE recipient IN (?,'all') OR sender=? ORDER BY id DESC LIMIT 50", me.handle, me.handle).reverse()
          : board.unread(me.handle);
        lines = messages.map(message => `${message.id} ${formatTime(message.ts)} ${message.sender} -> ${message.recipient}\n  ${message.body}`);
        board.markRead(me.handle, messages.map(message => message.id));
        if (!lines.length) lines = ['No messages'];
        break;
      }
      case 'approve': case 'deny': {
        const id = Number((positionals[0] || '').replace('#', ''));
        const status = command === 'approve' ? 'approved' : 'denied';
        lines = [await board.decide(me, id, status, positionals.slice(1).join(' '))];
        break;
      }
      case 'asks': {
        lines = board.all('SELECT * FROM asks ORDER BY id DESC LIMIT 100')
          .map(request => `${request.id} ${request.handle} -> ${request.host} [${request.status}] ${request.body}${request.decision_note ? ' | ' + request.decision_note : ''}`);
        break;
      }
      case 'history': case 'log': {
        const count = Number(options.n || (command === 'history' ? 40 : 30));
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('--n must be a positive integer');
        lines = command === 'history'
          ? board.all('SELECT * FROM claims ORDER BY id DESC LIMIT ?', count)
            .map(claim => `${claim.id} ${claim.target} ${claim.handle} ${formatTime(claim.since)} -> ${claim.ended_at ? formatTime(claim.ended_at) : 'active'}${claim.note ? ' | ' + claim.note : ''}`)
          : board.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', count)
            .map(event => `${formatTime(event.ts)} ${event.handle}: ${event.text}`);
        break;
      }
      case 'heat': lines = await board.heat(me); break;
      case 'who': {
        const snapshot = await board.snapshot();
        lines = [
          ...snapshot.agents.map(agent => `${agent.handle} (${agent.runtime}) last seen ${formatTime(agent.last_seen)}${agent.note ? ' | ' + agent.note : ''}`),
          ...snapshot.sessions.map(session => `Session: ${session.handle} (${session.runtime}) ${session.name} ${session.cwd || ''}`),
        ];
        break;
      }
      case 'status': {
        const snapshot = await board.snapshot();
        lines = ['Resource registrations are advisory. Check actual usage before starting work.'];
        for (const card of snapshot.cards) {
          lines.push(`${card.target}${card.approval ? ' [user approval required]' : ''}${card.live ? ` | ${card.live.util}% | ${card.live.used}/${card.live.total} MiB | ${card.live.temp ?? '?'} C` : ' | no monitor reading'}`);
          for (const claim of card.claims) lines.push(`  #${claim.id} ${claim.handle} until ${formatTime(claim.until)}${claim.share ? ' [sharing allowed]' : ''}${claim.mem ? ' <= ' + claim.mem : ''}${claim.note ? ' | ' + claim.note : ''}`);
          for (const want of card.wants) lines.push(`  Waiting: ${want.handle} for ${want.targets.join(', ')}${want.note ? ' | ' + want.note : ''}`);
          if (card.watch) lines.push(`  Watch: ${card.watch.hotCelsius} C; ${card.watch.note || 'temperature alert'}`);
        }
        for (const session of snapshot.sessions) lines.push(`Session: ${session.handle} (${session.runtime}) ${session.name}`);
        for (const request of snapshot.asks.filter(request => request.status === 'pending')) lines.push(`Pending #${request.id}: ${request.handle} -> ${request.host}: ${request.body}`);
        lines.push(`Identity: ${me.handle}; unread messages: ${board.unread(me.handle).length}. Use inbox to read.`);
        break;
      }
    }
    if (lines.length) console.log(lines.join('\n'));
    if (['claim', 'release', 'want', 'send', 'ask'].includes(command) && me.runtime !== 'shell') {
      const unread = board.unread(me.self).length;
      if (unread) console.log(`${me.self}: ${unread} unread messages. Use inbox to read.`);
    }
  } finally {
    board.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
