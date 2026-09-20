'use strict';
/**
 * Agent tools.
 *
 * The set is chosen for autonomy: an agent that cannot search cannot find its own
 * way around a repository, so glob/grep are first-class here. Destructive tools
 * route through a PermissionBroker instead of a modal dialog, so multi-step runs
 * are not interrupted by a popup every few seconds.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PermissionBroker, KIND_WRITE, KIND_EXEC } = require('./permissions');

function cfg() {
  return vscode.workspace.getConfiguration('workbuddyAgent');
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : process.cwd();
}

/** Resolve a path against the workspace root, guarding escapes. */
function resolveInWorkspace(target) {
  const root = workspaceRoot();
  const abs = path.isAbsolute(target) ? target : path.join(root, target);
  const normalized = path.normalize(abs);
  const rootNorm = path.normalize(root);
  if (normalized !== rootNorm && !normalized.startsWith(rootNorm + path.sep)) {
    throw new Error('path escapes the workspace: ' + target);
  }
  return normalized;
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n… [truncated ' + (s.length - max) + ' chars]';
}

/** Translate a simple glob (**, *, ?) into a RegExp over a forward-slash path. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** matches across separators
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.vscode-test', '__pycache__']);

/** Walk the workspace, calling visit(relativePath, absolutePath) for files. */
function walkFiles(root, visit, limit) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    if (count >= limit) return count;
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (count >= limit) return count;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (visit(rel, abs)) count++;
      }
    }
  }
  return count;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          maxChars: { type: 'number', description: 'Optional cap on returned characters (default 20000).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_edit',
      description: 'Replace an exact string in a file. Prefer this over write_file for small changes: '
        + 'the rest of the file is untouched. old_string must appear exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the contents of a directory in the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (default ".").' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.c". Use this to discover '
        + 'the layout of a project before reading anything.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, matched against workspace-relative paths.' },
          maxResults: { type: 'number', description: 'Max paths to return (default 100).' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_content',
      description: 'Search file contents with a regular expression and return matching lines with file '
        + 'and line number. Use this to find where a symbol is defined or used.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression.' },
          path: { type: 'string', description: 'Optional subdirectory to limit the search to.' },
          include: { type: 'string', description: 'Optional glob limiting which files are searched, e.g. "**/*.js".' },
          maxResults: { type: 'number', description: 'Max matches to return (default 60).' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Run a shell command in the workspace directory. Use it to build, test or inspect.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command to run.' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Get errors and warnings VS Code reports for the workspace, optionally limited to one file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional file path to filter by.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: 'Open a file in the editor and optionally reveal a line, so the user can see it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          line: { type: 'number', description: 'Optional 1-based line to reveal.' },
        },
        required: ['path'],
      },
    },
  },
];

/** Tool names that mutate state and therefore need permission. */
const MUTATING = new Set(['write_file', 'apply_edit', 'run_terminal']);

/**
 * Execute one tool call.
 *
 * @param name    tool name
 * @param args    parsed arguments
 * @param broker  PermissionBroker (a default deny-all broker is used when omitted)
 * @param hooks   { onDiff?: (path, before, after) => void }
 */
async function execute(name, args, broker, hooks) {
  const perm = broker || new PermissionBroker({});
  const hook = hooks || {};

  switch (name) {
    case 'read_file': {
      const file = resolveInWorkspace(args.path || '');
      const max = Number(args.maxChars) > 0 ? Number(args.maxChars) : 20000;
      const text = await fs.promises.readFile(file, 'utf8');
      return truncate(text, max);
    }

    case 'write_file': {
      const file = resolveInWorkspace(args.path || '');
      let before = '';
      try { before = await fs.promises.readFile(file, 'utf8'); } catch { /* new file */ }
      const after = args.content || '';
      if (before === after) return 'no change needed: ' + file;

      const ok = await perm.request(KIND_WRITE, {
        tool: 'write_file',
        path: path.relative(workspaceRoot(), file).split(path.sep).join('/'),
        summary: (before ? 'overwrite' : 'create') + ' ' + after.split('\n').length + ' lines',
        preview: truncate(after, 600),
      });
      if (!ok) return 'denied by the user';

      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, after, 'utf8');
      if (hook.onDiff) hook.onDiff(file, before, after);
      return (before ? 'updated ' : 'created ') + file;
    }

    case 'apply_edit': {
      const file = resolveInWorkspace(args.path || '');
      const before = await fs.promises.readFile(file, 'utf8');
      const oldStr = String(args.old_string == null ? '' : args.old_string);
      const newStr = String(args.new_string == null ? '' : args.new_string);
      if (!oldStr) return 'old_string must not be empty';

      const occurrences = before.split(oldStr).length - 1;
      if (occurrences === 0) return 'old_string not found in ' + file;
      if (occurrences > 1 && !args.replace_all) {
        return 'old_string appears ' + occurrences + ' times; pass replace_all or include more context';
      }
      const after = args.replace_all
        ? before.split(oldStr).join(newStr)
        : before.replace(oldStr, newStr);

      const ok = await perm.request(KIND_WRITE, {
        tool: 'apply_edit',
        path: path.relative(workspaceRoot(), file).split(path.sep).join('/'),
        summary: 'replace ' + (args.replace_all ? occurrences + ' occurrences' : '1 occurrence'),
        preview: truncate(newStr, 600),
      });
      if (!ok) return 'denied by the user';

      await fs.promises.writeFile(file, after, 'utf8');
      if (hook.onDiff) hook.onDiff(file, before, after);
      return 'edited ' + file;
    }

    case 'list_dir': {
      const dir = resolveInWorkspace(args.path || '.');
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries
        .filter(e => !SKIP_DIRS.has(e.name))
        .slice(0, 200)
        .map(e => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n');
    }

    case 'search_files': {
      const re = globToRegExp(String(args.pattern || '**/*'));
      const max = Number(args.maxResults) > 0 ? Number(args.maxResults) : 100;
      const hits = [];
      walkFiles(workspaceRoot(), (rel) => {
        if (re.test(rel)) hits.push(rel);
        return hits.length >= max;
      }, max * 4);
      if (!hits.length) return 'no files matched ' + args.pattern;
      return hits.slice(0, max).join('\n')
        + (hits.length >= max ? '\n… [capped at ' + max + ']' : '');
    }

    case 'search_content': {
      let re;
      try { re = new RegExp(String(args.pattern || ''), 'g'); }
      catch (e) { return 'invalid regular expression: ' + e.message; }
      const includeRe = args.include ? globToRegExp(String(args.include)) : null;
      const base = args.path ? resolveInWorkspace(args.path) : workspaceRoot();
      const max = Number(args.maxResults) > 0 ? Number(args.maxResults) : 60;
      const out = [];
      walkFiles(base, (rel, abs) => {
        if (includeRe && !includeRe.test(rel)) return false;
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { return false; }
        if (text.length > 2_000_000) return false;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && out.length < max; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            const relBase = path.relative(base, abs).split(path.sep).join('/');
            out.push(relBase + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 200));
          }
        }
        return out.length >= max;
      }, max * 8);
      if (!out.length) return 'no matches for ' + args.pattern;
      return out.join('\n') + (out.length >= max ? '\n… [capped at ' + max + ']' : '');
    }

    case 'run_terminal': {
      const command = String(args.command || '');
      const ok = await perm.request(KIND_EXEC, {
        tool: 'run_terminal',
        summary: 'run a shell command',
        preview: command,
      });
      if (!ok) return 'denied by the user';
      const cwd = workspaceRoot();
      return await new Promise((resolve) => {
        const child = spawn(command, { shell: true, cwd, windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 120000);
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('error', e => { clearTimeout(timer); resolve('failed to start: ' + e.message); });
        child.on('close', code => {
          clearTimeout(timer);
          resolve(truncate(
            (out || '') + (err ? (out ? '\n' : '') + 'stderr:\n' + err : '') + '\n[exit ' + code + ']',
            8000
          ));
        });
      });
    }

    case 'get_diagnostics': {
      const filter = args.path ? resolveInWorkspace(args.path) : null;
      const all = vscode.languages.getDiagnostics();
      const out = [];
      for (const [uri, diags] of all) {
        if (uri.scheme !== 'file') continue;
        if (filter && path.normalize(uri.fsPath) !== filter) continue;
        const rel = path.relative(workspaceRoot(), uri.fsPath).split(path.sep).join('/');
        for (const d of diags) {
          if (d.severity > 1) continue;               // 0 = Error, 1 = Warning
          const sev = d.severity === 0 ? 'error' : 'warning';
          out.push(rel + ':' + (d.range.start.line + 1) + ' ' + sev + ': ' + d.message);
          if (out.length >= 80) break;
        }
        if (out.length >= 80) break;
      }
      return out.length ? out.join('\n') : 'no errors or warnings';
    }

    case 'open_file': {
      const file = resolveInWorkspace(args.path || '');
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (Number(args.line) > 0) {
        const line = Math.max(0, Number(args.line) - 1);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return 'opened ' + file;
    }

    default:
      return 'unknown tool: ' + name;
  }
}

module.exports = { TOOLS, execute, resolveInWorkspace, MUTATING, workspaceRoot };
