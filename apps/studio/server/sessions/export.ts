/**
 * A session report as one self-contained HTML file: styles inline, screenshots
 * embedded, no scripts needed. Works offline, prints well, and reads right to
 * left when the report is in Arabic.
 */
import fs from 'node:fs';
import { BRAND } from '../../shared/brand.ts';
import { modelName } from '../../shared/models.ts';
import type { ReportFinding, SessionAnalysis, SessionMeta, SessionReport, Severity, TimelineItem } from '../../shared/session.ts';
import { HttpError } from '../http.ts';
import type { Sessions } from './index.ts';
import { clock } from './report.ts';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The words of a finding, and a stack trace it carries as code. */
function what(text: string): string {
  const lines = text.split('\n');
  const isFrame = (l: string) => /^\s*at\s/.test(l);
  const prose = lines.filter((l) => !isFrame(l)).join(' ').trim();
  const frames = lines.filter(isFrame).map((l) => l.trim());
  return `${prose ? `<p>${esc(prose)}</p>` : ''}${frames.length ? `<pre class="stack" dir="ltr">${esc(frames.join('\n'))}</pre>` : ''}`;
}

const SEV: Record<Severity, { en: string; ar: string; color: string }> = {
  critical: { en: 'Critical', ar: 'حرج', color: '#e5484d' },
  high: { en: 'High', ar: 'مرتفع', color: '#f76b15' },
  medium: { en: 'Medium', ar: 'متوسط', color: '#ffc53d' },
  low: { en: 'Low', ar: 'منخفض', color: '#8b8d98' },
};

const T = {
  en: { overall: 'Overall', stability: 'Stability', usability: 'Usability', performance: 'Performance', accessibility: 'Accessibility', findings: 'Findings', suggestions: 'Suggestions', positives: 'What worked', journey: 'What the tester did', next: 'Next steps', timeline: 'Timeline', transcript: 'What was said', expected: 'Expected', fix: 'Fix', where: 'Where', steps: 'Steps', said: 'Said', evidence: 'Evidence', verdict: { ship: 'No serious problems found', 'fix-first': 'Fix first', blocked: 'Blocked' }, clean: 'No technical problems found', scope: 'Saywright looks for errors, failed requests, slow responses and signs of frustration. It can’t tell whether the values on screen are right.', effort: 'Effort', by: 'Written by', translated: ', translated by', local: 'Written on this computer (no AI)', duration: 'Duration', recorded: 'Recorded' },
  ar: { overall: 'التقييم العام', stability: 'الاستقرار', usability: 'سهولة الاستخدام', performance: 'الأداء', accessibility: 'إمكانية الوصول', findings: 'الملاحظات', suggestions: 'الاقتراحات', positives: 'ما نجح', journey: 'ما قام به المختبِر', next: 'الخطوات التالية', timeline: 'التسلسل الزمني', transcript: 'ما قيل', expected: 'المتوقع', fix: 'الإصلاح', where: 'المكان', steps: 'الخطوات', said: 'قال', evidence: 'الأدلة', verdict: { ship: 'لا مشكلات خطيرة', 'fix-first': 'يحتاج إصلاحًا أولًا', blocked: 'متوقف' }, clean: 'لم تُرصد مشكلات تقنية', scope: 'يبحث Saywright عن الأخطاء والطلبات الفاشلة والاستجابات البطيئة وعلامات التعثّر، لكنه لا يستطيع أن يعرف إن كانت القيم المعروضة صحيحة.', effort: 'الجهد', by: 'كتبه', translated: '، وترجمه', local: 'كُتب على هذا الجهاز (بدون ذكاء اصطناعي)', duration: 'المدة', recorded: 'سُجّل' },
};

function ring(score: number, label: string, big = false): string {
  const r = big ? 46 : 30;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? '#30a46c' : score >= 65 ? '#ffc53d' : '#e5484d';
  const size = (r + 8) * 2;
  return `<div class="ring${big ? ' big' : ''}"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e8e8ec" stroke-width="${big ? 9 : 7}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${big ? 9 : 7}" stroke-linecap="round" stroke-dasharray="${((score / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size="${big ? 26 : 17}" font-weight="700" fill="#1c2024">${score}</text></svg><div class="ring-label">${esc(label)}</div></div>`;
}

function finding(f: ReportFinding, lang: 'en' | 'ar', shots: Map<string, string>, analysis: SessionAnalysis): string {
  const t = T[lang];
  const sev = SEV[f.severity];
  const pic = f.evidence.map((e) => analysis.timeline.find((x) => x.id === e && x.shot)).find(Boolean) as TimelineItem | undefined;
  const img = pic?.shot ? shots.get(pic.shot) : undefined;
  return `<article class="finding">
  <div class="f-head"><span class="sev" style="background:${sev.color}">${esc(sev[lang])}</span><span class="cat">${esc(f.category)}</span><h3>${esc(f.title)}</h3></div>
  <div class="f-body${img ? ' with-img' : ''}">
    <div>
      ${what(f.what)}
      ${f.quote ? `<blockquote>“${esc(f.quote)}”</blockquote>` : ''}
      ${f.expected ? `<p><b>${t.expected}:</b> ${esc(f.expected)}</p>` : ''}
      ${f.location ? `<p><b>${t.where}:</b> <code dir="ltr">${esc(f.location)}</code></p>` : ''}
      <p><b>${t.fix}:</b> ${esc(f.fix)}</p>
      ${f.steps.length ? `<details><summary>${t.steps}</summary><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>` : ''}
      ${f.evidence.length ? `<p class="ev">${t.evidence}: ${f.evidence.map((e) => `<a href="#${esc(e)}">${esc(e)}</a>`).join(' ')}</p>` : ''}
    </div>
    ${img ? `<img src="${img}" alt="">` : ''}
  </div>
</article>`;
}

export function renderHtml(meta: SessionMeta, analysis: SessionAnalysis, report: SessionReport, shots: Map<string, string>): string {
  const lang = report.lang;
  const t = T[lang];
  const s = analysis.scores;
  const verdictColor = report.verdict === 'ship' ? '#30a46c' : report.verdict === 'blocked' ? '#e5484d' : '#f76b15';
  const timeline = analysis.timeline
    .filter((x) => x.kind !== 'action' || x.issue)
    .slice(0, 400)
    .map((x) => `<tr id="${esc(x.id)}" class="k-${x.kind}"><td class="tc">${clock(x.t, meta.startedAt)}</td><td class="tid">${esc(x.id)}</td><td${x.kind === 'speech' ? ' dir="auto" class="speech"' : ''}>${esc(lang === 'ar' ? (x.textAr ?? x.text) : x.text)}${x.src ? ` <code dir="ltr">${esc(x.src)}</code>` : ''}${x.shot && shots.get(x.shot) ? `<br><img class="thumb" src="${shots.get(x.shot)}" alt="">` : ''}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(report.title)} · ${BRAND.name} session</title>
<style>
:root{--fg:#1c2024;--fg2:#60646c;--line:#e8e8ec;--bg:#fff;--soft:#f9f9fb;--accent:#0090ff}
*{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans Arabic",Tahoma,sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 20px 80px}
header{background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:28px}
.meta{color:var(--fg2);font-size:13px}.title{font-size:28px;line-height:1.25;margin:6px 0 10px;letter-spacing:-.01em}
.verdict{display:inline-block;color:#fff;background:${verdictColor};border-radius:99px;padding:3px 12px;font-weight:600;font-size:13px}
.scores{display:flex;flex-wrap:wrap;gap:18px;align-items:center;margin-top:22px}.ring{text-align:center}.ring-label{font-size:12.5px;color:var(--fg2)}
.summary{font-size:16px;margin:16px 0 0}
section{background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:24px;margin-top:18px}
h2{font-size:18px;margin:0 0 14px}
.finding{border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0;break-inside:avoid}
.f-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.f-head h3{font-size:16px;margin:0;flex:1 1 300px}
.sev{color:#fff;border-radius:6px;padding:1px 8px;font-size:12px;font-weight:700}.cat{color:var(--fg2);font-size:12px;border:1px solid var(--line);border-radius:6px;padding:0 6px}
.f-body{display:grid;gap:16px}.f-body.with-img{grid-template-columns:1fr 300px}.f-body img{width:100%;border-radius:10px;border:1px solid var(--line)}
blockquote{margin:8px 0;padding:6px 12px;border-inline-start:3px solid var(--accent);background:#f0f7ff;border-radius:6px}
pre.stack{margin:8px 0;padding:8px 12px;background:#f4f4f6;border-radius:6px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;text-align:left}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:0 5px}
.ev{font-size:12.5px;color:var(--fg2)}.ev a{color:var(--accent);margin-inline-end:6px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.card{border:1px solid var(--line);border-radius:12px;padding:12px}
.card b{display:block}.tag{font-size:11.5px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse;font-size:13.5px}td{border-top:1px solid var(--line);padding:6px 6px;vertical-align:top}
.tc{color:var(--fg2);white-space:nowrap;font-variant-numeric:tabular-nums}.tid{color:var(--fg2);font-size:12px}
.k-speech td{background:#f0f7ff}.k-error td,.k-network td,.k-frustration td{background:#fff5f5}.speech{font-weight:500}
.thumb{max-width:280px;margin-top:6px;border-radius:8px;border:1px solid var(--line)}
footer{color:var(--fg2);font-size:12.5px;text-align:center;margin-top:28px}
@media (max-width:720px){.f-body.with-img{grid-template-columns:1fr}}
@media print{body{background:#fff}section,header{border:none;padding:0}main{padding:0}}
</style>
</head>
<body>
<main>
<header>
  <div class="meta">${esc(new Date(meta.startedAt).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB'))} · ${t.duration} ${clock(meta.startedAt + analysis.durationMs, meta.startedAt)} · <span dir="ltr">${esc(meta.appUrl)}</span>${meta.git ? ` · <span dir="ltr">${esc(meta.git.branch)}@${esc(meta.git.commit)}</span>` : ''}</div>
  <h1 class="title">${esc(report.title)}</h1>
  <span class="verdict">${esc(report.verdict === 'ship' && !report.findings.length ? t.clean : t.verdict[report.verdict])}</span>
  <p class="summary">${esc(report.summary)}</p>
  ${report.verdict === 'ship' ? `<p class="meta">${esc(t.scope)}</p>` : ''}
  <div class="scores">${ring(s.overall, t.overall, true)}${ring(s.stability.score, t.stability)}${ring(s.usability.score, t.usability)}${ring(s.performance.score, t.performance)}${ring(s.accessibility.score, t.accessibility)}</div>
</header>
${report.findings.length ? `<section><h2>${t.findings} (${report.findings.length})</h2>${report.findings.map((f) => finding(f, lang, shots, analysis)).join('')}</section>` : ''}
${report.suggestions.length ? `<section><h2>${t.suggestions}</h2><div class="cols">${report.suggestions.map((g) => `<div class="card"><span class="tag">${esc(g.kind)} · ${t.effort}: ${esc(g.effort)}</span><b>${esc(g.title)}</b>${esc(g.why)}</div>`).join('')}</div></section>` : ''}
<section><div class="cols">
  ${report.journey.length ? `<div><h2>${t.journey}</h2><ol>${report.journey.map((j) => `<li>${esc(j)}</li>`).join('')}</ol></div>` : ''}
  ${report.positives.length ? `<div><h2>${t.positives}</h2><ul>${report.positives.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
  ${report.nextSteps.length ? `<div><h2>${t.next}</h2><ol>${report.nextSteps.map((p) => `<li>${esc(p)}</li>`).join('')}</ol></div>` : ''}
</div></section>
<section><h2>${t.timeline}</h2><table dir="ltr">${timeline}</table></section>
<footer>${BRAND.name} · ${report.source !== 'local' ? `${t.by} ${esc(modelName(report.model))}${report.translatedBy ? `${t.translated} ${esc(modelName(report.translatedBy))}` : ''}` : t.local}</footer>
</main>
</body>
</html>`;
}

/** The report as one page, in the language asked for when there is a version in it. */
export function exportHtml(sessions: Sessions, id: string, lang?: string | null): string {
  const { meta, analysis, report: main, translation, decisions } = sessions.detail(id);
  if (!analysis || !main) throw new HttpError(409, 'The report isn’t ready yet');
  const chosen = translation && translation.lang === lang ? translation : main;
  // Without the findings the tester set aside.
  const aside = new Set(main.findings.filter((f) => decisions.skipped.includes(f.title)).map((f) => f.id));
  const report = { ...chosen, findings: chosen.findings.filter((f) => !aside.has(f.id)) };
  const shots = new Map<string, string>();
  for (const s of analysis.shots) {
    try {
      shots.set(s.name, `data:image/jpeg;base64,${fs.readFileSync(sessions.store.shotFile(id, s.name)).toString('base64')}`);
    } catch {
      /* missing */
    }
  }
  return renderHtml(meta, analysis, report, shots);
}
