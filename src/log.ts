import * as vscode from 'vscode';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
}

export function createLogger(channel: vscode.OutputChannel): Logger {
  const write = (level: string, message: string): void => {
    channel.appendLine(`[${new Date().toISOString()}] ${level} ${message}`);
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    show: () => channel.show(true),
  };
}
