'use client';
import { useEffect, useState } from 'react';
import { teamInfo } from '../lib/teams';
const cache = {};
// Team logo (free image from Wikipedia); falls back to a coloured badge with the team code.
export function Logo({ team, size = 36 }) {
  const t = teamInfo(team);
  const [src, setSrc] = useState(cache[team]);
  useEffect(() => {
    if (!t.wiki || cache[team] !== undefined) { setSrc(cache[team]); return; }
    let dead = false;
    fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + t.wiki)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { cache[team] = (j && j.thumbnail && j.thumbnail.source) || null; if (!dead) setSrc(cache[team]); })
      .catch(() => { cache[team] = null; });
    return () => { dead = true; };
  }, [team]);
  const box = { width: size, height: size };
  return src
    ? <img src={src} alt={team} referrerPolicy="no-referrer" style={box} className="shrink-0 rounded-full bg-white object-contain p-0.5" />
    : <div style={{ ...box, background: t.color, fontSize: size / 3.2 }} className="grid shrink-0 place-items-center rounded-full font-bold text-white">{t.short}</div>;
}

export async function logoUrl(team) {   // used by the shareable squad images
  if (cache[team] !== undefined) return cache[team];
  const t = teamInfo(team);
  if (!t.wiki) return null;
  try {
    const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + t.wiki);
    const j = r.ok ? await r.json() : null;
    cache[team] = (j && j.thumbnail && j.thumbnail.source) || null;
  } catch (e) { cache[team] = null; }
  return cache[team];
}
