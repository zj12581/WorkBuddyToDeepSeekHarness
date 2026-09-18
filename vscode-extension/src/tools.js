'use strict';
/**
 * Agent tools. Each tool receives an approval callback; destructive ones must
 * ask unless the corresponding setting allows them.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function cfg() {
  return vscode.workspace.getConfiguration('workbuddyAgent');
}

/** Resolve a path against the first workspace folder, guarding escapes. */
function resolveInWorkspace(target) {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
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

async function ask(question, allowSetting, detail) {
  if (cfg().get(allowSetting)) return true;
  const answer = await vscode.window.showWarningMessage(question, { modal: true, detail }, 'Allow', 'Deny');
  return answer === 'Allow';
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
      description: 'Create or overwrite a file in the workspace. Asks for confirmation first.',
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
      name: 'run_terminal',
      description: 'Run a shell command in the workspace directory. Asks for confirmation first.',
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
      name: 'insert_at_cursor',
      description: 'Insert text at the cursor in the active editor.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to insert.' } },
        required: ['text'],
      },
    },
  },
];

async function execute(name, args) {
  switch (name) {
    case 'read_file': {
      const file = resolveInWorkspace(args.path || '');
      const max = Number(args.maxChars) > 0 ? Number(args.maxChars) : 20000;
      const text = await fs.promises.readFile(file, 'utf8');
      return truncate(text, max);
    }

    case 'write_file': {
      const file = resolveInWorkspace(args.path || '');
      const ok = await ask(
        'WorkBuddy Agent wants to write a file',
        'autoApproveFileWrites',
        file + '\n\n' + truncate(args.content, 800)
      );
      if (!ok) return 'denied by the user';
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, args.content || '', 'utf8');
      return 'wrote ' + file;
    }

    case 'list_dir': {
      const dir = resolveInWorkspace(args.path || '.');
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries
        .slice(0, 200)
        .map(e => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n');
    }

    case 'run_terminal': {
      const command = String(args.command || '');
      const ok = await ask('WorkBuddy Agent wants to run a command', 'autoApproveTerminal', command);
      if (!ok) return 'denied by the user';
      const cwdResolve = resolveInWorkspace('.');
      return await new Promise((resolve) => {
        const child = spawn(command, { shell: true, cwd: cwdResolve, windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60000);
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('error', e => { clearTimeout(timer); resolve('failed to start: ' + e.message); });
        child.on('close', code => {
          clearTimeout(timer);
          resolve(truncate(
            (out ? out : '') + (err ? (out ? '\n' : '') + 'stderr:\n' + err : '') + '\n[exit ' + code + ']',
            8000
          ));
        });
      });
    }

    case 'insert_at_cursor': {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return 'no active editor';
      await editor.edit(builder => builder.insert(editor.selection.active, args.text || ''));
      return 'inserted';
    }

    default:
      return 'unknown tool: ' + name;
  }
}

module.exports = { TOOLS, execute, resolveInWorkspace };
