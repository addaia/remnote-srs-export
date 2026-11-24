import { useEffect, useState } from 'react';
import { usePlugin, renderWidget, type RNPlugin } from '@remnote/plugin-sdk';

// ---------- helpers ----------

const SCORE_LABELS: Record<string, string> = {
  '0': 'Again',
  '0.01': 'Too early',
  '0.5': 'Hard',
  '1': 'Good',
  '1.5': 'Easy',
  '2': 'Viewed as leech',
  '3': 'Reset',
  '4': 'Manual date',
  '5': 'Manual ease',
};
const scoreLabel = (s: number) => SCORE_LABELS[String(s)] ?? String(s);

const iso = (t?: number) => (t ? new Date(t).toISOString() : '');

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + '…' : s);

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type RemInfo = { text: string; back: string; parent: string | null };

/** Loads rems (and their ancestors, up to `maxDepth` levels) into `cache`. */
async function loadRems(
  plugin: RNPlugin,
  ids: string[],
  cache: Map<string, RemInfo>,
  maxDepth: number,
  onProgress: (msg: string) => void
) {
  let toFetch = Array.from(new Set(ids)).filter((id) => !cache.has(id));
  for (let depth = 0; depth <= maxDepth && toFetch.length > 0; depth++) {
    const parents: string[] = [];
    const batches = chunk(toFetch, 300);
    for (let b = 0; b < batches.length; b++) {
      onProgress(
        depth === 0
          ? `Reading card text… ${Math.min((b + 1) * 300, toFetch.length)} / ${toFetch.length}`
          : `Reading document structure (level ${depth})…`
      );
      const rems = (await plugin.rem.findMany(batches[b])) ?? [];
      await Promise.all(
        rems.map(async (rem) => {
          const text = rem.text ? await plugin.richText.toString(rem.text) : '';
          const back = rem.backText ? await plugin.richText.toString(rem.backText) : '';
          cache.set(rem._id, { text, back, parent: rem.parent });
          if (rem.parent && !cache.has(rem.parent)) parents.push(rem.parent);
        })
      );
    }
    toFetch = Array.from(new Set(parents)).filter((id) => !cache.has(id));
  }
}

function pathOf(remId: string, cache: Map<string, RemInfo>): string {
  const parts: string[] = [];
  let cur = cache.get(remId)?.parent ?? null;
  let guard = 0;
  while (cur && guard++ < 20) {
    const info = cache.get(cur);
    if (!info) break;
    if (info.text.trim()) parts.unshift(clip(info.text.trim(), 60));
    cur = info.parent;
  }
  return parts.join(' > ');
}

function downloadText(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch {
    return false;
  }
}

// ---------- widget ----------

type Result = { cardsCsv: string; reviewsCsv: string; nCards: number; nReviews: number };

export const ExportPopup = () => {
  const plugin = usePlugin();
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [shown, setShown] = useState<'cards' | 'reviews' | null>(null);
  const [includeAncestors, setIncludeAncestors] = useState(true);

  // ----- scope: everything, or chosen documents / folders -----
  type Picked = { id: string; name: string };
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Picked[]>([]);
  const [recentDays, setRecentDays] = useState(0);

  // Remember the selection between exports.
  useEffect(() => {
    (async () => {
      const saved = await plugin.storage.getSynced<{ scope: 'all' | 'selected'; picked: Picked[]; recentDays: number }>('export-scope');
      if (saved) {
        setScope(saved.scope ?? 'all');
        setPicked(saved.picked ?? []);
        setRecentDays(saved.recentDays ?? 0);
      }
    })();
  }, []);
  useEffect(() => {
    plugin.storage.setSynced('export-scope', { scope, picked, recentDays });
  }, [scope, picked, recentDays]);

  const nameOf = async (rem: any) =>
    clip((rem?.text ? await plugin.richText.toString(rem.text) : '').trim() || '(untitled)', 80);

  function addPicked(items: Picked[]) {
    setPicked((cur) => {
      const ids = new Set(cur.map((p) => p.id));
      return [...cur, ...items.filter((i) => !ids.has(i.id))];
    });
    setScope('selected');
  }

  async function search(q: string) {
    setQuery(q);
    if (q.trim().length < 2) return setHits([]);
    const res = await plugin.search.search([q], undefined, { numResults: 12 });
    const list: Picked[] = [];
    for (const r of res) list.push({ id: r._id, name: await nameOf(r) });
    setHits(list);
  }

  async function addOpenDocs() {
    const ids = (await plugin.window.getOpenPaneRemIds()).filter(Boolean) as string[];
    if (!ids.length) return plugin.app.toast('No document is open');
    const rems = (await plugin.rem.findMany(ids)) ?? [];
    addPicked(await Promise.all(rems.map(async (r: any) => ({ id: r._id, name: await nameOf(r) }))));
  }

  async function runExport() {
    setRunning(true);
    setResult(null);
    setShown(null);
    try {
      setStatus('Loading flashcards…');
      let cards = await plugin.card.getAll();

      if (scope === 'selected') {
        if (!picked.length) throw new Error('Pick at least one document or folder first.');
        const inScope = new Set<string>();
        for (const p of picked) {
          setStatus(`Collecting notes under “${p.name}”…`);
          inScope.add(p.id);
          const root = await plugin.rem.findOne(p.id);
          const desc = root ? await root.getDescendants() : [];
          for (const d of desc) inScope.add(d._id);
        }
        cards = cards.filter((c) => inScope.has(c.remId));
      }
      if (recentDays > 0) {
        const since = Date.now() - recentDays * 86400000;
        cards = cards.filter((c) => (c.lastRepetitionTime ?? 0) >= since);
      }
      setStatus(`Found ${cards.length} cards.`);

      const cache = new Map<string, RemInfo>();
      await loadRems(
        plugin,
        cards.map((c) => c.remId),
        cache,
        includeAncestors ? 8 : 0,
        setStatus
      );

      setStatus('Building CSV…');
      const cardRows: unknown[][] = [];
      const reviewRows: unknown[][] = [];

      for (const c of cards) {
        const rem = cache.get(c.remId);
        const hist = (c.repetitionHistory ?? []).slice().sort((a, b) => a.date - b.date);
        const counts = { again: 0, hard: 0, good: 0, easy: 0 };
        let totalMs = 0;
        let timed = 0;
        for (const h of hist) {
          if (h.score === 0) counts.again++;
          else if (h.score === 0.5) counts.hard++;
          else if (h.score === 1) counts.good++;
          else if (h.score === 1.5) counts.easy++;
          if (typeof h.responseTime === 'number') {
            totalMs += h.responseTime;
            timed++;
          }
          reviewRows.push([
            c._id,
            clip(rem?.text ?? '', 120),
            iso(h.date),
            scoreLabel(h.score),
            h.score,
            h.responseTime ?? '',
            h.responseTime != null ? (h.responseTime / 1000).toFixed(1) : '',
            iso(h.scheduled),
            h.isCram ? 'yes' : '',
          ]);
        }
        const answered = counts.again + counts.hard + counts.good + counts.easy;
        const type =
          typeof c.type === 'string' ? c.type : c.type && 'clozeId' in c.type ? 'cloze' : '';

        cardRows.push([
          c._id,
          c.remId,
          includeAncestors ? pathOf(c.remId, cache) : '',
          clip(rem?.text ?? ''),
          clip(rem?.back ?? ''),
          type,
          iso(c.createdAt),
          answered,
          counts.again,
          counts.hard,
          counts.good,
          counts.easy,
          answered ? (counts.again / answered).toFixed(2) : '',
          c.timesWrongInRow ?? '',
          (totalMs / 1000).toFixed(1),
          timed ? (totalMs / timed / 1000).toFixed(1) : '',
          iso(c.lastRepetitionTime),
          iso(c.nextRepetitionTime),
        ]);
      }

      const cardsCsv = toCsv(
        [
          'card_id',
          'rem_id',
          'location',
          'front',
          'back',
          'card_type',
          'created',
          'reviews',
          'again',
          'hard',
          'good',
          'easy',
          'again_rate',
          'times_wrong_in_row',
          'total_time_s',
          'avg_time_s',
          'last_review',
          'next_due',
        ],
        cardRows
      );
      const reviewsCsv = toCsv(
        [
          'card_id',
          'front',
          'date',
          'answer',
          'score',
          'response_time_ms',
          'response_time_s',
          'scheduled_for',
          'cram',
        ],
        reviewRows
      );

      setResult({ cardsCsv, reviewsCsv, nCards: cards.length, nReviews: reviewRows.length });
      setStatus(`Done: ${cards.length} cards, ${reviewRows.length} reviews.`);
    } catch (e: any) {
      setStatus(`Something went wrong: ${e?.message ?? e}`);
    } finally {
      setRunning(false);
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      await plugin.app.toast(`${what} copied to clipboard`);
    } catch {
      setShown(what === 'Cards CSV' ? 'cards' : 'reviews');
      await plugin.app.toast('Clipboard blocked — select the text below and copy it');
    }
  }

  function save(name: string, text: string, which: 'cards' | 'reviews') {
    const ok = downloadText(name, text);
    // If the download is blocked we show the text so it can be copied manually.
    if (!ok) setShown(which);
  }

  const btn =
    'px-3 py-1.5 rounded-md text-sm font-medium border rn-clr-border-opaque hover:opacity-80 disabled:opacity-40';

  return (
    <div className="p-4 flex flex-col gap-3" style={{ width: 520, maxWidth: '100%' }}>
      <h1 className="text-lg font-semibold">SRS Data Export</h1>
      <p className="text-sm rn-clr-content-secondary">
        Exports every flashcard with its review history. Read-only — nothing in your knowledge
        base is changed.
      </p>

      <div className="flex flex-col gap-2 p-2 rounded-md border rn-clr-border-opaque">
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} disabled={running} />
            All cards
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} disabled={running} />
            Only chosen documents / folders
          </label>
        </div>

        {scope === 'selected' && (
          <>
            <div className="flex gap-2">
              <input
                className="flex-1 px-2 py-1 text-sm border rounded rn-clr-border-opaque rn-clr-background-primary"
                placeholder="Search for a document or folder…"
                value={query}
                onChange={(e) => search(e.target.value)}
                disabled={running}
              />
              <button className={btn} onClick={addOpenDocs} disabled={running}>
                + Open document
              </button>
            </div>
            {hits.length > 0 && (
              <div className="flex flex-col text-sm max-h-40 overflow-auto border rounded rn-clr-border-opaque">
                {hits.map((h) => (
                  <button
                    key={h.id}
                    className="text-left px-2 py-1 hover:opacity-70"
                    onClick={() => {
                      addPicked([h]);
                      setHits([]);
                      setQuery('');
                    }}
                  >
                    + {h.name}
                  </button>
                ))}
              </div>
            )}
            {picked.length === 0 ? (
              <div className="text-xs rn-clr-content-secondary">
                Nothing chosen yet. Everything inside a chosen document or folder is included.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {picked.map((p) => (
                  <span key={p.id} className="text-xs px-2 py-0.5 rounded-full border rn-clr-border-opaque">
                    {p.name}{' '}
                    <button onClick={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))} disabled={running}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <label className="flex items-center gap-2 text-sm">
          Only cards reviewed in the last
          <input
            type="number"
            min={0}
            className="w-16 px-1 border rounded rn-clr-border-opaque rn-clr-background-primary"
            value={recentDays}
            onChange={(e) => setRecentDays(Math.max(0, Number(e.target.value) || 0))}
            disabled={running}
          />
          days (0 = no limit)
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeAncestors}
          onChange={(e) => setIncludeAncestors(e.target.checked)}
          disabled={running}
        />
        Include where each card lives (document › section). Slower on big knowledge bases.
      </label>

      <button className={btn} onClick={runExport} disabled={running}>
        {running ? 'Exporting…' : result ? 'Export again' : 'Export'}
      </button>

      {status && <div className="text-sm">{status}</div>}

      {result && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-sm w-36">Cards ({result.nCards})</span>
            <button className={btn} onClick={() => save(`srs-cards-${stamp}.csv`, result.cardsCsv, 'cards')}>
              Download
            </button>
            <button className={btn} onClick={() => copy(result.cardsCsv, 'Cards CSV')}>
              Copy
            </button>
            <button className={btn} onClick={() => setShown('cards')}>
              Show
            </button>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-sm w-36">Reviews ({result.nReviews})</span>
            <button className={btn} onClick={() => save(`srs-reviews-${stamp}.csv`, result.reviewsCsv, 'reviews')}>
              Download
            </button>
            <button className={btn} onClick={() => copy(result.reviewsCsv, 'Reviews CSV')}>
              Copy
            </button>
            <button className={btn} onClick={() => setShown('reviews')}>
              Show
            </button>
          </div>
          <p className="text-xs rn-clr-content-secondary">
            If Download does nothing, use Copy (or Show, then select all and copy) and paste into a
            text file saved as .csv.
          </p>
        </div>
      )}

      {result && shown && (
        <textarea
          readOnly
          className="w-full text-xs font-mono p-2 border rounded rn-clr-border-opaque"
          style={{ height: 220 }}
          value={shown === 'cards' ? result.cardsCsv : result.reviewsCsv}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </div>
  );
};

renderWidget(ExportPopup);
