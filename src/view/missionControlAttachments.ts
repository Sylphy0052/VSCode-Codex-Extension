import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatSize, MAX_ATTACHMENT_BYTES, type AttachmentInput } from '../provider/attachments';

/**
 * Mission ControlのComposerで添付するファイルを選ぶ（Issue #2158）。
 *
 * 画像（png / jpeg / gif / webp）は中身をデータURLにして返し、会話へ画像として添える。
 * 画像以外は会話へ添付する経路が無い（チャットタブも`@パス`でCLIに読ませている）ため、パスを
 * 返して本文へ`@パス`を差し込ませる。
 */
export interface PickedAttachments {
  attachments: AttachmentInput[];
  paths: string[];
  /** 選ばれたが添えられなかったもの（大きすぎる画像など）の理由。 */
  skipped: string[];
}

/** 拡張子から画像の種類を決める。チャットタブの添付（`SUPPORTED_MEDIA_TYPES`）と同じ4種。 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function imageMediaType(filePath: string): string | undefined {
  return IMAGE_TYPES[path.extname(filePath).toLowerCase()];
}

/**
 * 選ばれたファイルを、画像（データURL）とそれ以外（パス）に分ける。
 * 大きすぎる画像は読まずに理由を返す（上限の最終判定は受け取った会話の`AttachmentBox`が持つ）。
 */
export async function classifyPickedFiles(
  filePaths: readonly string[],
): Promise<PickedAttachments> {
  const picked: PickedAttachments = { attachments: [], paths: [], skipped: [] };
  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    const mediaType = imageMediaType(filePath);
    if (mediaType === undefined) {
      picked.paths.push(filePath);
      continue;
    }
    try {
      const info = await stat(filePath);
      if (info.size > MAX_ATTACHMENT_BYTES) {
        picked.skipped.push(
          `${name}: 1枚あたり ${formatSize(MAX_ATTACHMENT_BYTES)} までです（${formatSize(info.size)}）`,
        );
        continue;
      }
      const data = await readFile(filePath);
      picked.attachments.push({
        name,
        dataUrl: `data:${mediaType};base64,${data.toString('base64')}`,
      });
    } catch (e: unknown) {
      picked.skipped.push(`${name}: 読み込めませんでした（${String(e)}）`);
    }
  }
  return picked;
}

/** ファイル選択のダイアログを出す。取りやめたら`undefined`。 */
export async function pickAttachmentFiles(
  defaultDir: string | undefined,
): Promise<PickedAttachments | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: '添付する',
    title: '会話へ添付するファイル（画像は画像として、ほかは@パスとして送ります）',
    ...(defaultDir === undefined ? {} : { defaultUri: vscode.Uri.file(defaultDir) }),
  });
  if (uris === undefined || uris.length === 0) {
    return undefined;
  }
  return classifyPickedFiles(uris.map((uri) => uri.fsPath));
}
