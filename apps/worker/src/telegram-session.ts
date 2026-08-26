import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import { getConfig } from "@hn-knowledge/config";
import { TelegramClient } from "@mtcute/node";

class MuteableTerminalOutput extends Writable {
  muted = false;

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.muted) {
      callback();
      return;
    }
    process.stdout.write(chunk, callback);
  }
}

const main = async (): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Telegram session initialization requires an interactive TTY",
    );
  }

  const config = getConfig();
  if (
    config.TELEGRAM_API_ID === undefined ||
    config.TELEGRAM_API_HASH === undefined
  ) {
    throw new Error("Telegram API credentials are not configured");
  }

  process.umask(0o077);
  const sessionPath = resolve(config.TELEGRAM_SESSION_PATH);
  await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(sessionPath), 0o700);

  const output = new MuteableTerminalOutput();
  const terminal = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const hiddenQuestion = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    output.muted = true;
    try {
      return await terminal.question("");
    } finally {
      output.muted = false;
      process.stdout.write("\n");
    }
  };

  const client = new TelegramClient({
    apiId: config.TELEGRAM_API_ID,
    apiHash: config.TELEGRAM_API_HASH,
    storage: sessionPath,
    disableUpdates: true,
  });

  try {
    await client.start({
      phone: () => terminal.question("Phone number: "),
      code: () => hiddenQuestion("Login code: "),
      password: () => hiddenQuestion("2FA password: "),
    });
  } finally {
    terminal.close();
    await client.destroy();
  }

  const session = await stat(sessionPath);
  if (!session.isFile() || session.size === 0) {
    throw new Error("Telegram session file was not created");
  }
  await chmod(sessionPath, 0o600);
  console.log(JSON.stringify({ event: "telegram_session_ready" }));
};

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "telegram_session_init_failed",
    }),
  );
  process.exitCode = 1;
}
