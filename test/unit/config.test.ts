import { beforeEach, describe, expect, it } from 'vitest';
import { readWorkflowsConfig } from '../../src/config';
import { __mock } from '../mocks/vscode';

describe('readWorkflowsConfig（レビュー指摘: warning）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('既定値は .agents/workflows', () => {
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('通常の相対パスはそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.dir': 'workflows' });
    expect(readWorkflowsConfig().dir).toBe('workflows');
  });

  it('..を含む値はワークスペース外を候補に混ぜられるため既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.dir': '../../outside' });
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('絶対パスも既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.dir': '/etc/evil' });
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('途中に..を含む値も既定値へ落とす（前方一致だけでなくセグメント単位で見る）', () => {
    __mock.setConfig('agent', { 'workflows.dir': 'a/../../b' });
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('allowAutoApproveの既定はfalse', () => {
    expect(readWorkflowsConfig().allowAutoApprove).toBe(false);
  });
});
