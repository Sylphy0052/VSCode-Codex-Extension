import { render } from 'preact';
import { App } from './app';
import { createBridge, type VsCodeApi } from './bridge';

/**
 * Mission Control（Issue #2136）のwebviewの入口。esbuildで`dist/missionControl.js`へ
 * 1ファイルにまとめ、nonce付きの`<script src>`で読む（`missionControlView.ts`）。
 */
declare function acquireVsCodeApi(): VsCodeApi;

const root = document.getElementById('root');
if (root !== null) {
  render(<App bridge={createBridge(acquireVsCodeApi(), window)} />, root);
}
