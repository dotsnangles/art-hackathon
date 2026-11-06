import horseUrl from './assets/horse.gif?url';
import type { CrawlSnapshot } from '@akl/graph-contract';
import type { DisposableScope } from '@akl/lab-kit';
import { pageHref, visitedHistory, type SiteFixture } from './data.ts';
import { createCardSpace } from './card-space.ts';
export interface FrontendView { begin(fixture: SiteFixture): void; update(snapshot: CrawlSnapshot): void; setStatus?(message: string): void; setLoading?(loading: boolean): void; append?(fixture: SiteFixture, anchorId: string): void }
export function createFrontend(container: HTMLElement, scope: DisposableScope,
  onSearch: (query: string) => void, initialQuery = '', onContinue?: (nodeId: string) => void, onReturnToSearch?: () => void): FrontendView {
  container.innerHTML = `<main class="stack-app" data-phase="entry">
    <button type="button" class="return-to-search" aria-label="검색어 입력 화면으로 돌아가기"><span aria-hidden="true"></span></button>
    <div class="relevance-legend" aria-label="검색어 연관도 색상표">
      <div><span class="relevance-dot" data-level="4" aria-hidden="true"></span> : 검색어 연관 4순위</div>
      <div><span class="relevance-dot" data-level="3" aria-hidden="true"></span> : 검색어 연관 3순위</div>
      <div><span class="relevance-dot" data-level="2" aria-hidden="true"></span> : 검색어 연관 2순위</div>
      <div><span class="relevance-dot" data-level="1" aria-hidden="true"></span> : 검색어 연관 1순위</div>
    </div>
    <section class="stack-stage" aria-label="카드스택">
      <form class="stack-query"><label>검색어: <input aria-label="검색어" maxlength="100" required /></label> <button type="button" class="query-history-toggle" aria-label="검색어 기록 펼치기" aria-expanded="false">▾</button><ol class="query-history" aria-label="검색어 기록" hidden></ol><output class="search-status" role="status"></output></form>
      <section class="page-preview" hidden aria-label="선택한 웹사이트"><div class="preview-frame"></div><a class="preview-original" target="_blank" rel="noopener noreferrer">원문 새 탭에서 열기</a></section>
      <section class="stack-detail" hidden><p></p><button type="button" class="back">되돌아가기</button> <button type="button" class="decompose" disabled title="콘텐츠 분해 기능은 준비 중입니다">분해 (준비 중)</button> <button type="button" class="continue-search">검색 이어가기</button></section>
    </section>
    <aside class="history" aria-label="탐색 히스토리"><div class="history-rail"><div class="history-scene"><ol class="history-list" aria-label="방문 페이지 최신순"><li class="history-title">history</li></ol></div></div></aside>
    <div class="search-loading" hidden role="status" aria-label="검색 중입니다">
      <img class="loading-horse" src="${horseUrl}" alt="" />
      <div class="loading-bar" role="progressbar" aria-label="검색 응답 대기"><span></span></div>
      <p aria-hidden="true">검색중입니다<span class="loading-dots">..</span></p>
    </div>
  </main>`;
  const app = container.querySelector<HTMLElement>('.stack-app')!;
  const loadingOverlay = container.querySelector<HTMLElement>('.search-loading')!;
  const loadingDots = loadingOverlay.querySelector<HTMLElement>('.loading-dots')!;
  let loadingElapsed = 0;
  function setLoading(loading: boolean) {
    loadingOverlay.hidden = !loading; loadingElapsed = 0; loadingDots.textContent = '..';
    app.setAttribute('aria-busy', String(loading));
    for (const child of Array.from(app.children)) {
      if (child !== loadingOverlay) (child as HTMLElement).inert = loading;
    }
    if (loading) { closePreview(); setQueryHistoryOpen(false); }
  }
  const stage = container.querySelector<HTMLElement>('.stack-stage')!;
  const form = container.querySelector<HTMLFormElement>('form')!;
  const input = form.querySelector('input')!; input.value = initialQuery;
  const detail = container.querySelector<HTMLElement>('.stack-detail')!;
  const preview = container.querySelector<HTMLElement>('.page-preview')!;
  const frameHost = preview.querySelector<HTMLElement>('.preview-frame')!;
  const original = preview.querySelector<HTMLAnchorElement>('a')!;
  function closePreview() {
    const frame = frameHost.querySelector('iframe');
    if (frame) { frame.src = 'about:blank'; frame.remove(); }
    preview.hidden = true;
  }
  scope.add(closePreview);
  const list = container.querySelector<HTMLOListElement>('.history-list')!;
  const historyTitle = list.querySelector<HTMLElement>('.history-title')!;
  const queryHistory = form.querySelector<HTMLOListElement>('.query-history')!;
  const queryToggle = form.querySelector<HTMLButtonElement>('.query-history-toggle')!;
  function setQueryHistoryOpen(open: boolean) {
    queryHistory.hidden = !open; queryToggle.setAttribute('aria-expanded', String(open));
    queryToggle.setAttribute('aria-label', open ? '검색어 기록 접기' : '검색어 기록 펼치기');
    queryToggle.textContent = open ? '▴' : '▾';
  }
  const queryStops: { query: string; pageIds: string[] }[] = [];
  function addQuery(query: string, pageIds: string[]) {
    const item = document.createElement('li'); const button = document.createElement('button');
    button.type = 'button'; button.textContent = query; button.dataset.stopIndex = String(queryStops.length);
    queryStops.push({ query, pageIds }); item.append(button); queryHistory.append(item);
  }
  scope.trackListener(queryHistory, 'click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-stop-index]');
    if (!button) return;
    const stop = queryStops[Number(button.dataset.stopIndex)]; if (!stop) return;
    closePreview(); detail.hidden = true; selectedId = null; input.value = stop.query;
    space.visitStack(stop.pageIds); setQueryHistoryOpen(false);
  });
  scope.trackListener(queryToggle, 'click', () => setQueryHistoryOpen(queryHistory.hidden));
  const panel = container.querySelector<HTMLElement>('.history')!;
  const rail = container.querySelector<HTMLElement>('.history-rail')!;
  let fixture: SiteFixture | null = null;
  let selectedId: string | null = null;
  let velocity = 0; let offset = 0;
  const seen = new Set<string>();
  const space = createCardSpace(stage, scope, (id) => {
    const page = fixture?.pages.find((item) => item.node.id === id);
    if (!page) return;
    selectedId = id; space.focus(id); detail.querySelector('p')!.textContent = page.node.content?.title ?? page.node.domain;
    closePreview();
    const frame = document.createElement('iframe');
    frame.title = page.node.content?.title ?? page.node.domain;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.src = page.href; frameHost.append(frame); original.href = page.href; preview.hidden = false;
    detail.hidden = false;
  });
  scope.trackListener(container.querySelector('.return-to-search')!, 'click', () => {
    onReturnToSearch?.(); setLoading(false); closePreview(); space.reset();
    fixture = null; selectedId = null; seen.clear(); list.replaceChildren(historyTitle);
    offset = 0; velocity = 0; detail.hidden = true;
    app.dataset.phase = 'entry'; input.value = ''; queryHistory.replaceChildren(); queryStops.length = 0; setQueryHistoryOpen(false);
    container.querySelector('output')!.textContent = ''; input.focus();
  });
  scope.trackListener(form, 'submit', (event) => { event.preventDefault(); if (input.value.trim()) { input.blur(); onSearch(input.value.trim()); } });
  scope.trackListener(detail, 'click', (event) => {
    if ((event.target as Element).closest('button')) closePreview();
  });
  scope.trackListener(detail.querySelector('.continue-search')!, 'click', () => {
    if (selectedId && onContinue) { detail.hidden = true; space.back(); onContinue(selectedId); }
  });
  scope.trackListener(detail.querySelector('.back')!, 'click', () => { detail.hidden = true; space.back(); });
  scope.trackListener(panel, 'pointermove', (event) => {
    const rect = panel.getBoundingClientRect(); const y = ((event as PointerEvent).clientY - rect.top) / rect.height;
    velocity = y < .4 ? (y - .4) * 900 : y > .6 ? (y - .6) * 900 : 0;
  });
  scope.trackListener(panel, 'pointerleave', () => { velocity = 0; });
  scope.trackListener(panel, 'wheel', (event) => { const e = event as WheelEvent; e.preventDefault(); offset += e.deltaY; }, { passive: false });
  scope.trackRaf((_time, _wrapped, dt) => {
    if (!loadingOverlay.hidden) {
      loadingElapsed += dt;
      loadingDots.textContent = '.'.repeat([2, 3, 4, 3, 2][Math.floor(loadingElapsed / .35) % 5]!);
    }
    offset = Math.max(0, Math.min(Math.max(0, list.getBoundingClientRect().height - panel.clientHeight * .65), offset + velocity * dt));
    rail.style.transform = `translateY(${-offset}px)`;
  });
  return {
    setLoading,
    setStatus(message) { container.querySelector('output')!.textContent = message; },
    append(next, anchorId) { closePreview();
      const previousIds = new Set(fixture?.pages.map(page => page.node.id));
      addQuery(next.query, next.pages.filter(page => !previousIds.has(page.node.id)).map(page => page.node.id));
      fixture = next; input.value = next.query; detail.hidden = true; space.append(next, anchorId); },
    begin(next) {
      closePreview(); fixture = next; seen.clear(); list.replaceChildren(historyTitle); offset = 0; detail.hidden = true;
      queryHistory.replaceChildren(); queryStops.length = 0; addQuery(next.query, next.pages.map(page => page.node.id)); setQueryHistoryOpen(false);
      input.value = next.query; app.dataset.phase = 'map'; space.begin(next);
    },
    update(snapshot) {
      if (!fixture) return;
      space.update(snapshot);
      for (const entry of visitedHistory(snapshot).reverse()) {
        if (seen.has(entry.id)) continue;
        const node = snapshot.nodeMap.get(entry.nodeId!); if (!node) continue;
        seen.add(entry.id);
        const item = document.createElement('li'); item.className = 'history-page';
        const anchor = document.createElement('a'); anchor.href = pageHref(node); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        anchor.textContent = node.content?.title ?? node.domain;
        const text = document.createElement('p'); text.textContent = node.content?.snippet ?? '';
        item.append(anchor, text); historyTitle.after(item);
      }
    },
  };
}
