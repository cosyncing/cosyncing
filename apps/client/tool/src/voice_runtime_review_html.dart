import 'dart:convert';

/// Renders a self-contained human-review console for one valid voice evidence
/// document.
///
/// The page never records audio and does not infer runtime success. It exports
/// a new JSON revision for the existing voice evidence validator.
String renderVoiceRuntimeReviewHtml(
  Map<String, Object?> evidence, {
  required String sourceEvidence,
}) {
  final embeddedEvidence = _jsonForInlineScript(evidence);
  final embeddedSource = _jsonForInlineScript(sourceEvidence);
  return '''
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Voice runtime review</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17201d;
      --muted: #5b6863;
      --line: #cbd4cf;
      --line-strong: #889791;
      --paper: #f5f7f4;
      --surface: #ffffff;
      --teal: #0f766e;
      --teal-soft: #d9eeea;
      --green: #247245;
      --green-soft: #ddf1e4;
      --amber: #8a6818;
      --amber-soft: #f4e8c8;
      --red: #a6322a;
      --red-soft: #f7dfdc;
      --charcoal: #25312d;
      --shadow: 0 10px 28px rgba(20, 34, 29, 0.08);
      font-family: Aptos, "Segoe UI Variable", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      min-width: 320px;
    }

    button, textarea { font: inherit; }

    button:focus-visible, textarea:focus-visible {
      outline: 3px solid rgba(15, 118, 110, 0.28);
      outline-offset: 2px;
    }

    .topbar {
      background: var(--charcoal);
      color: #fff;
      border-bottom: 4px solid #d0aa4d;
    }

    .topbar-inner {
      max-width: 1440px;
      margin: 0 auto;
      padding: 22px 28px 20px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
    }

    .eyebrow {
      margin: 0 0 5px;
      color: #b9cbc4;
      font: 700 12px/1.2 ui-monospace, "Cascadia Mono", monospace;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    h1 {
      margin: 0;
      font: 600 29px/1.15 Georgia, "Times New Roman", serif;
      letter-spacing: 0;
    }

    .target-badge {
      flex: 0 0 auto;
      padding: 7px 10px;
      border: 1px solid rgba(255,255,255,0.35);
      border-radius: 4px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      font: 700 13px/1 ui-monospace, "Cascadia Mono", monospace;
      text-transform: uppercase;
    }

    .layout {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px 28px 110px;
      display: grid;
      grid-template-columns: minmax(250px, 310px) minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }

    .side {
      position: sticky;
      top: 18px;
      display: grid;
      gap: 16px;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 6px;
      box-shadow: var(--shadow);
    }

    .panel-heading {
      margin: 0;
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
      line-height: 1.2;
    }

    .facts { margin: 0; padding: 8px 16px 14px; }

    .fact {
      padding: 9px 0;
      border-bottom: 1px solid #e5eae7;
    }

    .fact:last-child { border-bottom: 0; }

    .fact dt {
      margin: 0 0 3px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .fact dd {
      margin: 0;
      overflow-wrap: anywhere;
      font: 500 12px/1.45 ui-monospace, "Cascadia Mono", monospace;
    }

    .preflight-list { margin: 0; padding: 8px 16px 14px; list-style: none; }

    .preflight-item {
      display: grid;
      grid-template-columns: 9px minmax(0, 1fr);
      gap: 9px;
      padding: 8px 0;
      border-bottom: 1px solid #e5eae7;
    }

    .preflight-item:last-child { border-bottom: 0; }

    .dot {
      width: 9px;
      height: 9px;
      margin-top: 4px;
      border-radius: 50%;
      background: var(--amber);
    }

    .dot.pass { background: var(--green); }

    .check-id {
      display: block;
      margin-bottom: 2px;
      font: 700 11px/1.3 ui-monospace, "Cascadia Mono", monospace;
    }

    .check-detail { color: var(--muted); font-size: 12px; line-height: 1.4; }

    .progress-panel { padding: 16px; }

    .progress-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .progress-value {
      font: 700 22px/1 ui-monospace, "Cascadia Mono", monospace;
    }

    .progress-track {
      height: 8px;
      overflow: hidden;
      border-radius: 4px;
      background: #e3e9e5;
    }

    .progress-fill {
      width: 0;
      height: 100%;
      background: var(--teal);
      transition: width 180ms ease;
    }

    .progress-caption {
      margin: 9px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .main { min-width: 0; }

    .intro {
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 20px;
    }

    .intro h2 {
      margin: 0 0 4px;
      font: 600 22px/1.2 Georgia, "Times New Roman", serif;
    }

    .intro p { margin: 0; color: var(--muted); font-size: 13px; }

    .counts {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .count {
      padding: 5px 8px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--surface);
      font: 700 11px/1 ui-monospace, "Cascadia Mono", monospace;
    }

    .observation-list {
      display: grid;
      gap: 10px;
    }

    .observation {
      display: grid;
      grid-template-columns: minmax(220px, 0.95fr) minmax(360px, 1.35fr);
      gap: 20px;
      padding: 18px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-left: 5px solid var(--line-strong);
      border-radius: 6px;
      box-shadow: 0 4px 14px rgba(20, 34, 29, 0.05);
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }

    .observation.reviewed { border-left-color: var(--teal); }
    .observation.status-pass { border-left-color: var(--green); }
    .observation.status-fail { border-left-color: var(--red); }
    .observation.status-not-run { border-left-color: var(--amber); }

    .observation:focus-within {
      border-color: var(--teal);
      box-shadow: 0 6px 20px rgba(15, 118, 110, 0.12);
    }

    .observation-id {
      margin: 0 0 8px;
      color: var(--teal);
      font: 700 12px/1.3 ui-monospace, "Cascadia Mono", monospace;
      overflow-wrap: anywhere;
    }

    .observation-description {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
    }

    .review-controls { min-width: 0; }

    .segmented {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 10px;
    }

    .status-button {
      min-height: 38px;
      padding: 8px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font: 700 11px/1 ui-monospace, "Cascadia Mono", monospace;
    }

    .status-button:hover { background: #f1f5f2; }
    .status-button[data-status="PASS"].active { background: var(--green-soft); border-color: var(--green); color: #155431; }
    .status-button[data-status="FAIL"].active { background: var(--red-soft); border-color: var(--red); color: #79231e; }
    .status-button[data-status="NOT_RUN"].active { background: var(--amber-soft); border-color: var(--amber); color: #654b0d; }

    .note-label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .note {
      width: 100%;
      min-height: 70px;
      resize: vertical;
      padding: 9px 10px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      background: #fbfcfb;
      color: var(--ink);
      line-height: 1.45;
    }

    .note.invalid { border-color: var(--red); background: #fff8f7; }

    .actionbar {
      position: fixed;
      z-index: 10;
      left: 0;
      right: 0;
      bottom: 0;
      border-top: 1px solid var(--line-strong);
      background: rgba(255,255,255,0.97);
      box-shadow: 0 -10px 30px rgba(20, 34, 29, 0.1);
    }

    .actionbar-inner {
      max-width: 1440px;
      margin: 0 auto;
      padding: 14px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .gate { min-width: 0; }

    .gate-title {
      margin: 0 0 3px;
      font-size: 13px;
      font-weight: 700;
    }

    .gate-message {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .actions { display: flex; gap: 8px; flex: 0 0 auto; }

    .command {
      min-height: 40px;
      padding: 9px 14px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      font-weight: 700;
    }

    .command:hover { background: #f1f5f2; }

    .command.primary {
      border-color: var(--teal);
      background: var(--teal);
      color: #fff;
    }

    .command.primary:hover { background: #0b655e; }
    .command:disabled { cursor: not-allowed; opacity: 0.45; }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0,0,0,0);
      white-space: nowrap;
      border: 0;
    }

    @media (max-width: 1023px) {
      .topbar-inner { align-items: flex-start; }
      .layout { grid-template-columns: 1fr; padding: 18px 16px 125px; }
      .side { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .progress-panel { grid-column: 1 / -1; }
      .observation { grid-template-columns: 1fr; }
      .actionbar-inner { padding: 12px 16px; align-items: flex-start; }
      .actions { flex-wrap: wrap; justify-content: flex-end; }
    }

    @media (max-width: 620px) {
      .topbar-inner { padding: 18px 16px; flex-direction: column; }
      h1 { font-size: 24px; }
      .layout { padding-bottom: 230px; }
      .side { grid-template-columns: 1fr; }
      .intro { align-items: flex-start; flex-direction: column; }
      .counts { justify-content: flex-start; }
      .segmented { grid-template-columns: 1fr; }
      .actionbar-inner { flex-direction: column; }
      .actions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
      .command.primary { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div>
        <p class="eyebrow">cosyncing / validation evidence</p>
        <h1>Voice runtime review</h1>
      </div>
      <div class="target-badge" id="target-badge"></div>
    </div>
  </header>

  <div class="layout">
    <aside class="side">
      <section class="panel" aria-labelledby="environment-title">
        <h2 class="panel-heading" id="environment-title">Environment</h2>
        <dl class="facts" id="environment-facts"></dl>
      </section>

      <section class="panel" aria-labelledby="preflight-title">
        <h2 class="panel-heading" id="preflight-title">Preflight</h2>
        <ul class="preflight-list" id="preflight-list"></ul>
      </section>

      <section class="panel progress-panel" aria-labelledby="progress-title">
        <div class="progress-row">
          <h2 class="panel-heading sr-only" id="progress-title">Review progress</h2>
          <strong>Review progress</strong>
          <span class="progress-value" id="progress-value">0/0</span>
        </div>
        <div class="progress-track" aria-hidden="true">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
        <p class="progress-caption" id="progress-caption"></p>
      </section>
    </aside>

    <main class="main">
      <div class="intro">
        <div>
          <h2>Observation queue</h2>
          <p>Run each check on the target app. Record what happened, not what was expected. This page never records audio.</p>
        </div>
        <div class="counts" id="counts" aria-label="Status counts"></div>
      </div>
      <div class="observation-list" id="observation-list"></div>
    </main>
  </div>

  <footer class="actionbar">
    <div class="actionbar-inner">
      <div class="gate" aria-live="polite">
        <p class="gate-title" id="gate-title">Evidence incomplete</p>
        <p class="gate-message" id="gate-message"></p>
      </div>
      <div class="actions">
        <button class="command" id="reset-button" type="button">Reset draft</button>
        <button class="command" id="copy-button" type="button">Copy summary</button>
        <button class="command primary" id="export-button" type="button" disabled>Export evidence JSON</button>
      </div>
    </div>
  </footer>

  <script id="seed-evidence" type="application/json">$embeddedEvidence</script>
  <script>
    'use strict';

    const sourceEvidence = $embeddedSource;
    const initialEvidence = JSON.parse(document.getElementById('seed-evidence').textContent);
    const unrecordedNote = 'Runtime observation not recorded.';
    const storageKey = 'cosyncing.voice-review.' + initialEvidence.target + '.' + initialEvidence.createdAt;
    const observationIds = Object.keys(initialEvidence.observations);
    let evidence = structuredClone(initialEvidence);
    let reviewed = Object.fromEntries(observationIds.map((id) => [id, false]));

    function loadDraft() {
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey));
        if (!parsed || !parsed.evidence || !parsed.reviewed) return;
        if (Object.keys(parsed.evidence.observations || {}).join('|') !== observationIds.join('|')) return;
        evidence = parsed.evidence;
        reviewed = parsed.reviewed;
      } catch (_) {
        clearDraft();
      }
    }

    function saveDraft() {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ evidence, reviewed }));
      } catch (_) {
        // Draft persistence is optional when file:// storage is unavailable.
      }
    }

    function clearDraft() {
      try {
        localStorage.removeItem(storageKey);
      } catch (_) {
        // Reset still works in memory when file:// storage is unavailable.
      }
    }

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function renderEnvironment() {
      document.getElementById('target-badge').textContent = evidence.target;
      const facts = document.getElementById('environment-facts');
      const entries = [
        ['App', evidence.appVersion],
        ['Operator', evidence.operator],
        ['Created', evidence.createdAt],
        ...Object.entries(evidence.environment || {}),
      ];
      entries.forEach(([key, value]) => {
        const wrap = element('div', 'fact');
        wrap.append(element('dt', '', key), element('dd', '', String(value)));
        facts.append(wrap);
      });
    }

    function renderPreflight() {
      const list = document.getElementById('preflight-list');
      evidence.preflight.checks.forEach((check) => {
        const item = element('li', 'preflight-item');
        const dot = element('span', 'dot' + (check.status === 'PASS' ? ' pass' : ''));
        const text = element('div');
        text.append(
          element('span', 'check-id', check.status + ' / ' + check.id),
          element('span', 'check-detail', check.detail),
        );
        item.append(dot, text);
        list.append(item);
      });
    }

    function noteIsSpecific(note) {
      const trimmed = String(note || '').trim();
      return trimmed.length >= 8 && trimmed !== unrecordedNote;
    }

    function setStatus(id, status) {
      evidence.observations[id].status = status;
      reviewed[id] = true;
      saveDraft();
      renderObservations();
      updateSummary();
    }

    function setNote(id, note) {
      evidence.observations[id].note = note;
      saveDraft();
      updateSummary();
      const textarea = document.querySelector('[data-note-for="' + CSS.escape(id) + '"]');
      textarea.classList.toggle('invalid', reviewed[id] && !noteIsSpecific(note));
    }

    function renderObservations() {
      const list = document.getElementById('observation-list');
      list.replaceChildren();
      observationIds.forEach((id, index) => {
        const observation = evidence.observations[id];
        const article = element('article', 'observation');
        if (reviewed[id]) article.classList.add('reviewed', 'status-' + observation.status.toLowerCase().replace('_', '-'));
        article.id = 'observation-' + index;

        const description = element('div');
        description.append(
          element('p', 'observation-id', String(index + 1).padStart(2, '0') + ' / ' + id),
          element('p', 'observation-description', observation.description),
        );

        const controls = element('div', 'review-controls');
        const segmented = element('div', 'segmented');
        ['PASS', 'FAIL', 'NOT_RUN'].forEach((status) => {
          const button = element('button', 'status-button', status.replace('_', ' '));
          button.type = 'button';
          button.dataset.status = status;
          button.setAttribute('aria-pressed', String(reviewed[id] && observation.status === status));
          if (reviewed[id] && observation.status === status) button.classList.add('active');
          button.addEventListener('click', () => setStatus(id, status));
          segmented.append(button);
        });

        const label = element('label', 'note-label', 'Observation note');
        label.htmlFor = 'note-' + index;
        const note = element('textarea', 'note');
        note.id = 'note-' + index;
        note.dataset.noteFor = id;
        note.value = observation.note === unrecordedNote ? '' : observation.note;
        note.placeholder = observation.status === 'NOT_RUN'
          ? 'Why was this check not run?'
          : 'What did you directly observe?';
        note.classList.toggle('invalid', reviewed[id] && !noteIsSpecific(note.value));
        note.addEventListener('input', (event) => setNote(id, event.target.value));
        controls.append(segmented, label, note);
        article.append(description, controls);
        list.append(article);
      });
    }

    function computeOverall() {
      const statuses = observationIds.map((id) => evidence.observations[id].status);
      if (statuses.includes('FAIL')) return 'FAIL';
      if (statuses.some((status) => status !== 'PASS')) return 'NOT_RUN';
      return 'PASS';
    }

    function reviewErrors() {
      const errors = [];
      observationIds.forEach((id) => {
        if (!reviewed[id]) errors.push(id + ' has no explicit status.');
        if (reviewed[id] && !noteIsSpecific(evidence.observations[id].note)) {
          errors.push(id + ' needs a specific note of at least 8 characters.');
        }
      });
      if (computeOverall() === 'PASS' && evidence.preflight.status !== 'READY') {
        errors.push('All-PASS evidence requires READY preflight.');
      }
      return errors;
    }

    function updateSummary() {
      const reviewedCount = observationIds.filter((id) => reviewed[id]).length;
      const percent = observationIds.length === 0 ? 0 : Math.round(reviewedCount * 100 / observationIds.length);
      document.getElementById('progress-value').textContent = reviewedCount + '/' + observationIds.length;
      document.getElementById('progress-fill').style.width = percent + '%';
      document.getElementById('progress-caption').textContent = percent + '% explicitly reviewed. Drafts stay in this browser until export.';

      const counts = { PASS: 0, FAIL: 0, NOT_RUN: 0, PENDING: 0 };
      observationIds.forEach((id) => {
        if (reviewed[id]) counts[evidence.observations[id].status] += 1;
        else counts.PENDING += 1;
      });
      const countsNode = document.getElementById('counts');
      countsNode.replaceChildren();
      ['PASS', 'FAIL', 'NOT_RUN', 'PENDING'].forEach((status) => {
        countsNode.append(element('span', 'count', status.replace('_', ' ') + ' ' + counts[status]));
      });

      const errors = reviewErrors();
      const exportButton = document.getElementById('export-button');
      exportButton.disabled = errors.length !== 0;
      document.getElementById('gate-title').textContent = errors.length === 0
        ? 'Ready to export / overall ' + computeOverall()
        : 'Evidence incomplete / ' + errors.length + ' gate' + (errors.length === 1 ? '' : 's');
      document.getElementById('gate-message').textContent = errors.length === 0
        ? 'The exported JSON still needs the repository validator before it counts as evidence.'
        : errors[0];
    }

    function exportedEvidence() {
      const result = structuredClone(evidence);
      result.updatedAt = new Date().toISOString();
      result.sourceEvidence = sourceEvidence;
      result.overallStatus = computeOverall();
      return result;
    }

    function exportJson() {
      if (reviewErrors().length !== 0) return;
      const result = exportedEvidence();
      const blob = new Blob([JSON.stringify(result, null, 2) + '\\n'], { type: 'application/json' });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace('.', '-');
      anchor.download = result.target + '-runtime-evidence-' + stamp + '.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    }

    async function copySummary() {
      const lines = observationIds.map((id) => {
        const observation = evidence.observations[id];
        const status = reviewed[id] ? observation.status : 'PENDING';
        const note = observation.note === unrecordedNote ? '' : observation.note.trim();
        return status + ' | ' + id + (note ? ' | ' + note : '');
      });
      await navigator.clipboard.writeText(lines.join('\\n'));
      document.getElementById('gate-message').textContent = 'Summary copied to clipboard.';
    }

    function resetDraft() {
      if (!confirm('Reset every status and note to the source evidence?')) return;
      clearDraft();
      evidence = structuredClone(initialEvidence);
      reviewed = Object.fromEntries(observationIds.map((id) => [id, false]));
      renderObservations();
      updateSummary();
    }

    loadDraft();
    renderEnvironment();
    renderPreflight();
    renderObservations();
    updateSummary();
    document.getElementById('export-button').addEventListener('click', exportJson);
    document.getElementById('copy-button').addEventListener('click', () => copySummary().catch(() => {
      document.getElementById('gate-message').textContent = 'Clipboard access was denied by the browser.';
    }));
    document.getElementById('reset-button').addEventListener('click', resetDraft);
  </script>
</body>
</html>
'''
      .trimLeft();
}

String _jsonForInlineScript(Object? value) {
  return jsonEncode(value)
      .replaceAll('<', r'\u003c')
      .replaceAll('>', r'\u003e')
      .replaceAll('&', r'\u0026')
      .replaceAll('\u2028', r'\u2028')
      .replaceAll('\u2029', r'\u2029');
}
