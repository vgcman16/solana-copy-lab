import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath =
  process.env.COPYLAB_NODE_REPL_SERVER ?? path.join(workspace, "tools", "node_repl.exe");

if (!existsSync(serverPath)) {
  throw new Error(
    `Node REPL server not found at ${serverPath}. Set COPYLAB_NODE_REPL_SERVER to its absolute path.`,
  );
}

const server = spawn(serverPath, [], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stdoutBuffer = "";
const pending = new Map();

server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`server-output: ${line}\n`);
      continue;
    }

    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

server.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

server.on("exit", (code) => {
  process.stderr.write(`node-repl-server-exited: ${code}\n`);
  process.exit(code ?? 1);
});

function request(method, params = {}) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const initialized = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "copylab-browser-client", version: "1.0.0" },
});

if (initialized.error) {
  process.stdout.write(`${JSON.stringify(initialized)}\n`);
  process.exit(1);
}

server.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
);
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of input) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: `invalid-command: ${error.message}` })}\n`,
    );
    continue;
  }

  if (command.exit) {
    server.kill();
    break;
  }

  const toolCall = {
    name: command.tool,
    arguments: command.arguments ?? {},
  };
  if (command.meta) toolCall._meta = command.meta;

  const response = await request("tools/call", toolCall);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
