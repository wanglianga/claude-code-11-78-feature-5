// ============================================================
// UI 渲染冒烟（Node + renderToString）：验证全部页面组件树
// 可正常渲染、路由与 Provider 装配无误（交互与 IndexedDB
// 行为由 db.test.ts 与手工验证覆盖）。
// ============================================================

import 'fake-indexeddb/auto';
import { describe, expect, it, beforeAll } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../state/auth';
import { AppProvider } from '../state/app';
import LoginPage from '../ui/pages/LoginPage';
import LoaderPage from '../ui/pages/LoaderPage';
import AlignmentPage from '../ui/pages/AlignmentPage';
import RulesPage from '../ui/pages/RulesPage';
import VerificationPage from '../ui/pages/VerificationPage';
import EventsPage from '../ui/pages/EventsPage';
import EventDetailPage from '../ui/pages/EventDetailPage';
import EvidencePage from '../ui/pages/EvidencePage';
import DisposalPage from '../ui/pages/DisposalPage';
import SyncPage from '../ui/pages/SyncPage';
import SelfCheckPage from '../ui/pages/SelfCheckPage';
import SafetyPage, {
  Overview,
  LedgerTab,
  LabelsTab,
  CohortTab,
  MetricsTab,
  GateTab,
  GrayTab,
} from '../ui/pages/SafetyPage';
import { buildSafetyDataset } from '../core/safetyScenario';
import { evaluateSafety } from '../core/safetyEval';

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

function render(el: React.ReactElement) {
  return renderToString(
    <MemoryRouter>
      <AuthProvider>
        <AppProvider>{el}</AppProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('页面组件渲染冒烟', () => {
  const pages: Array<[string, React.ReactElement]> = [
    ['登录页', <LoginPage key="login" />],
    ['装载器页', <LoaderPage key="loader" />],
    ['对齐页', <AlignmentPage key="align" />],
    ['规则页', <RulesPage key="rules" />],
    ['核验页', <VerificationPage key="verify" />],
    ['事件列表页', <EventsPage key="events" />],
    ['事件调查页', <EventDetailPage key="detail" />],
    ['证据图页', <EvidencePage key="evidence" />],
    ['处置簿页', <DisposalPage key="disposal" />],
    ['同步对照页', <SyncPage key="sync" />],
    ['自检页', <SelfCheckPage key="selfcheck" />],
    ['安全评估页', <SafetyPage key="safety" />],
  ];

  for (const [name, el] of pages) {
    it(`${name}可渲染`, () => {
      const html = render(el);
      expect(html.length).toBeGreaterThan(0);
    });
  }

  it('安全评估全部子视图在真实产物上可渲染', () => {
    const ev = evaluateSafety(buildSafetyDataset());
    const views: Array<[string, React.ReactElement]> = [
      ['总览', <Overview key="ov" ev={ev} />],
      ['冻结账本', <LedgerTab key="lg" ledger={ev.ledger} filtered={ev.ledger} tier="ALL" setTier={() => {}} />],
      ['结果归因', <LabelsTab key="lb" ev={ev} />],
      ['可比性诊断', <CohortTab key="co" ev={ev} />],
      ['分层指标', <MetricsTab key="mt" ev={ev} />],
      ['安全门禁', <GateTab key="gt" ev={ev} />],
      ['灰度轨迹', <GrayTab key="gy" ev={ev} />],
    ];
    for (const [, el] of views) {
      const html = renderToString(<MemoryRouter><AuthProvider><AppProvider>{el}</AppProvider></AuthProvider></MemoryRouter>);
      expect(html.length).toBeGreaterThan(0);
    }
    const gate = renderToString(<GateTab ev={ev} />);
    expect(gate).toContain(ev.gate.verdict === 'advisory_only' ? '回退：仅展示建议' : '门禁');
  });

  it('登录页包含三个测试账号', () => {
    const html = render(<LoginPage />);
    expect(html).toContain('王监管');
    expect(html).toContain('张巡检');
    expect(html).toContain('陈审计');
  });
});
