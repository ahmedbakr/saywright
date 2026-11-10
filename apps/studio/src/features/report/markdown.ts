/** A report as Markdown, for pasting into an issue, a PR or a chat. */
import { BRAND } from '@shared/brand';
import { modelName } from '@shared/models';
import { nothingToJudge, replayReason, type SessionDetail, type SessionTarget } from '@shared/session';
import { fmtClock } from './Findings';
import { STRINGS } from './i18n';

export function nameOfTarget(el: SessionTarget): string {
  if (el.description) return el.description;
  const label = el.label || el.text;
  return label ? `the “${label.slice(0, 40)}” ${el.role ?? el.name}` : el.name;
}

export function toMarkdown(detail: SessionDetail): string {
  const { meta, analysis: a, report: r } = detail;
  if (!a || !r) return '';
  const t = STRINGS[r.lang];
  const skipped = new Set(detail.decisions?.skipped ?? []);
  // Set aside by the tester (kept by their title in the report's own language; ids match across languages).
  const aside = new Set((detail.report ?? r).findings.filter((f) => skipped.has(f.title)).map((f) => f.id));
  const findings = r.findings.filter((f) => !aside.has(f.id));
  const lines: string[] = [];
  const s = a.scores;
  // Nothing was tried: no score, no “no problems found”.
  if (nothingToJudge(a)) {
    lines.push(`## ${t.nothing}`, '', `**${meta.name}** · ${new Date(meta.startedAt).toLocaleString()} · ${fmtClock(a.durationMs)} · ${meta.appUrl}`, '', t.nothingWhy, '');
    return lines.join('\n');
  }
  lines.push(`## ${r.title}`, '');
  lines.push(`**${meta.name}** · ${new Date(meta.startedAt).toLocaleString()} · ${fmtClock(a.durationMs)} · ${meta.appUrl}${meta.git ? ` · \`${meta.git.branch}@${meta.git.commit}\`` : ''}`, '');
  lines.push(r.summary, '');
  lines.push(`| ${t.overall} | ${t.stability} | ${t.usability} | ${t.performance} | ${t.accessibility} |`, `|---|---|---|---|---|`, `| **${s.overall}** | ${s.stability.score} | ${s.usability.score} | ${s.performance.score} | ${s.accessibility.score} |`, '');
  // After fixes: what a replay of the session found.
  const v = detail.verification;
  const verdicts = v ? findings.map((f) => v.findings[f.id]).filter(Boolean) : [];
  if (v && verdicts.length) {
    const n = (k: string) => verdicts.filter((x) => x.verdict === k).length;
    const failed = v.steps.failed;
    lines.push(`**${t.verifyTitle}:** ${t.verifySummary(n('fixed'), n('still'), n('unknown'))}. ${t.replayed(v.steps.done, v.steps.total)}.${failed ? ` ${t.stoppedAt(r.lang === 'ar' ? (failed.descriptionAr ?? failed.description) : failed.description, replayReason(failed.reason, r.lang))}` : ''}`, '');
  }
  if (findings.length) {
    lines.push(`### ${t.findings}`, '');
    findings.forEach((f, i) => {
      const verdict = v?.findings[f.id];
      lines.push(`${i + 1}. **[${t.severity[f.severity]}] ${f.title}**${verdict ? ` · ${verdict.verdict === 'fixed' ? '✅' : verdict.verdict === 'still' ? '❌' : '❔'} ${t.verdicts[verdict.verdict]}: ${r.lang === 'ar' ? verdict.whyAr : verdict.why}` : ''}`);
      lines.push(`   ${f.what}`);
      if (f.quote) lines.push(`   > “${f.quote}”`);
      if (f.expected) lines.push(`   ${t.expected}: ${f.expected}`);
      if (f.location) lines.push(`   ${t.where}: \`${f.location}\``);
      lines.push(`   ${t.howToFix}: ${f.fix}`);
      if (f.steps.length) lines.push(`   ${t.steps}: ${f.steps.join(' → ')}`);
      lines.push('');
    });
  }
  if (r.suggestions.length) {
    lines.push(`### ${t.suggestions}`, '');
    for (const g of r.suggestions) lines.push(`- **${t[g.kind]}** (${t.effort[g.effort]}): ${g.title}. ${g.why}`);
    lines.push('');
  }
  if (r.nextSteps.length) {
    lines.push(`### ${t.nextSteps}`, '');
    r.nextSteps.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    lines.push('');
  }
  lines.push(`_Recorded with ${BRAND.name}${r.source !== 'local' ? `; report by ${modelName(r.model)}` : ''}._`);
  return lines.join('\n');
}
