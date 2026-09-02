import { useState, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TablePagination from '@mui/material/TablePagination';
import TableSortLabel from '@mui/material/TableSortLabel';
import SearchIcon from '@mui/icons-material/Search';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import { api, PlaylistItem, Track, Classifier } from '../api';
import { DataTable } from '../components';
import { rememberSearchQuery, lastSearchQuery } from '../searchParams';

interface Props { authed: boolean; }

type SortKey = 'name' | 'year' | 'duration';

// ---------------------------------------------------------------------------
// Fuzzy matching (client-side, instant): every query token must appear in the
// track's title+artists+album, either as a substring or with 1-char edits.
// ---------------------------------------------------------------------------

function lev1(a: string, b: string): boolean {
  // True when a and b are at most one edit apart (sub / ins / del).
  if (a === b) return true;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a]; // x shorter
  if (y.length - x.length > 1) return false;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  if (x.length === y.length) {
    for (let j = i + 1; j < x.length; j++) if (x[j] !== y[j]) return false;
    return true; // one substitution
  }
  for (let j = i; j < x.length; j++) if (x[j] !== y[j + 1]) return false;
  return true; // one insertion/deletion
}

function tokenMatches(tok: string, hay: string): boolean {
  if (hay.includes(tok)) return true;
  if (tok.length < 4) return false;
  for (let w = tok.length - 1; w <= tok.length + 1; w++) {
    for (let i = 0; i + w <= hay.length; i++) {
      if (lev1(hay.slice(i, i + w), tok)) return true;
    }
  }
  return false;
}

function fuzzyMatch(query: string, hay: string): boolean {
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 2);
  if (!tokens.length) return true;
  return tokens.every((tok) => tokenMatches(tok, hay));
}

// ---------------------------------------------------------------------------

interface Filters {
  artist: string;
  album: string;
  title: string;
  minYear: string;
  maxYear: string;
  minDur: string;   // seconds
  maxDur: string;
  language: string;
  // dynamic AI-field values keyed by classifier id
  ai: Record<number, any>;
}

const EMPTY_AI: Record<number, any> = {};
const baseFilters = (ai: Filters['ai']): Filters => ({
  artist: '', album: '', title: '', minYear: '', maxYear: '',
  minDur: '', maxDur: '', language: '', ai,
});

const yearOf = (t: Track) => (t.release_date || '').slice(0, 4);

// ---------------------------------------------------------------------------
// URL <-> view state: the query string (/search?pl=4&q=leon) mirrors the
// whole Search view (playlist, every filter, paging, sort), so a refresh or
// a shared link restores it exactly. Keys: pl q ar al ti ymin ymax dmin
// dmax lang pg rs sk sd ai<CID>.
// ---------------------------------------------------------------------------

function encodeAi(v: any): string | null {
  if (v === true) return 't';
  if (typeof v === 'string' && v.trim()) return 's:' + v;
  if (v && typeof v === 'object') {
    const min = v.min !== undefined && v.min !== '' ? String(v.min) : '';
    const max = v.max !== undefined && v.max !== '' ? String(v.max) : '';
    if (min || max) return 'r:' + min + '~' + max;
  }
  return null;
}

function decodeAi(s: string): any {
  if (s === 't') return true;
  if (s.startsWith('s:')) return s.slice(2);
  if (s.startsWith('r:')) {
    const body = s.slice(2);
    const i = body.indexOf('~');
    return { min: i >= 0 ? body.slice(0, i) : body, max: i >= 0 ? body.slice(i + 1) : '' };
  }
  return s;
}

function viewToQuery(pid: number | '', query: string, f: Filters, page: number, rows: number, sortKey: SortKey, sortDir: 'asc' | 'desc'): string {
  const p = new URLSearchParams();
  if (pid !== '') p.set('pl', String(pid));
  if (query.trim()) p.set('q', query.trim());
  if (f.artist.trim()) p.set('ar', f.artist.trim());
  if (f.album.trim()) p.set('al', f.album.trim());
  if (f.title.trim()) p.set('ti', f.title.trim());
  if (f.minYear) p.set('ymin', f.minYear);
  if (f.maxYear) p.set('ymax', f.maxYear);
  if (f.minDur) p.set('dmin', f.minDur);
  if (f.maxDur) p.set('dmax', f.maxDur);
  if (f.language) p.set('lang', f.language);
  for (const [cid, v] of Object.entries(f.ai)) {
    const enc = encodeAi(v);
    if (enc !== null) p.set('ai' + cid, enc);
  }
  if (page > 0) p.set('pg', String(page));
  if (rows !== 50) p.set('rs', String(rows));
  if (sortKey !== 'name') p.set('sk', sortKey);
  if (sortDir !== 'asc') p.set('sd', sortDir);
  return p.toString();
}

// The query string to initialize from: whatever is in the URL now, else the
// one remembered from the last time this page was visible.
function initialQuery(): string {
  const s = window.location.search;
  return s ? s.slice(1) : lastSearchQuery();
}

// The backend already unwraps the model's JSON/fence wrapper, but if a raw
// blob ever slips through (older backend, odd model behavior) sanitize it here.
function cleanExplanation(raw: string): string {
  let t = (raw || '').trim();
  const m = t.match(/^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (m) t = m[1].trim();
  try {
    const d: any = JSON.parse(t);
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const k of ['explanation', 'reason', 'answer', 'text']) {
        if (typeof d[k] === 'string' && d[k].trim()) return d[k].trim();
      }
    }
    if (typeof d === 'string' && d.trim()) return d.trim();
  } catch { /* not JSON - leave as-is */ }
  return t;
}

export default function Search({ authed }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  // The initial view comes from the URL query string (/search?pl=4&q=...),
  // or from what the page remembered before (see ../searchParams).
  const [pid, setPid] = useState<number | ''>(() => {
    // (default playlist preference applied when the list loads)
    const pl = new URLSearchParams(initialQuery()).get('pl');
    return pl && !Number.isNaN(Number(pl)) ? Number(pl) : '';
  });
  const [tracks, setTracks] = useState<Track[]>([]);
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(() => new URLSearchParams(initialQuery()).get('q') || '');
  const [f, setF] = useState<Filters>(() => {
    const p = new URLSearchParams(initialQuery());
    const out = baseFilters({});
    const str = (k: string, key: 'artist' | 'album' | 'title') => { const v = p.get(k); if (v) out[key] = v; };
    str('ar', 'artist'); str('al', 'album'); str('ti', 'title');
    const rng = (k: string, key: 'minYear' | 'maxYear' | 'minDur' | 'maxDur') => { const v = p.get(k); if (v) out[key] = v; };
    rng('ymin', 'minYear'); rng('ymax', 'maxYear'); rng('dmin', 'minDur'); rng('dmax', 'maxDur');
    const lang = p.get('lang'); if (lang) out.language = lang;
    const ai: Record<number, any> = {};
    for (const [k, v] of p.entries()) {
      if (k.startsWith('ai') && /^\d+$/.test(k.slice(2))) ai[Number(k.slice(2))] = decodeAi(v);
    }
    out.ai = ai;
    return out;
  });
  const [page, setPage] = useState(() => Number(new URLSearchParams(initialQuery()).get('pg') || 0) || 0);
  const [rows, setRows] = useState(() => Number(new URLSearchParams(initialQuery()).get('rs') || 50) || 50);
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const v = new URLSearchParams(initialQuery()).get('sk');
    return v === 'year' || v === 'duration' ? v : 'name';
  });
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() =>
    new URLSearchParams(initialQuery()).get('sd') === 'desc' ? 'desc' : 'asc');
  // per-track AI reasoning dialog
  const [reasonFor, setReasonFor] = useState<{ t: Track; c: Classifier } | null>(null);
  const [explanation, setExplanation] = useState('');
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState('');
  // save current search as a generated playlist
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [savePreview, setSavePreview] = useState(true);
  const [saveMode, setSaveMode] = useState('once');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');

  const openReason = (t: Track, c: Classifier) => {
    setReasonFor({ t, c });
    setExplanation('');
    setExplainError('');
    setExplaining(false);
  };
  const fetchExplanation = async () => {
    if (!reasonFor) return;
    setExplaining(true);
    setExplainError('');
    try {
      const r: any = await api.explainClassifierValue(reasonFor.c.id, reasonFor.t.id);
      setExplanation(cleanExplanation(r.explanation || '(no explanation returned)'));
    } catch (e: any) {
      setExplainError(e?.message || String(e));
    } finally {
      setExplaining(false);
    }
  };

  // Load the playlist's tracks (with pre-computed AI values) + classifiers.
  // ALL filtering below is client-side: instant, zero LLM, zero round-trips.
  useEffect(() => {
    if (!pid) { setTracks([]); return; }
    let alive = true;
    setLoading(true); setError('');
    Promise.all([api.tracks(pid), api.classifiers()])
      .then(([t, c]: [Track[], Classifier[]]) => {
        if (!alive) return;
        setTracks(Array.isArray(t) ? t : []);
        setClassifiers(Array.isArray(c) ? c : []);
      })
      .catch((e: any) => { if (alive) setError(e?.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [pid]);

  useEffect(() => {
    api.playlists()
      .then((d: PlaylistItem[]) => {
        const list = Array.isArray(d) ? d : [];
        setPlaylists(list);
        // open with the user-configured default playlist (fallback: first)
        setPid((cur) => (cur === '' && list.length ? (list.find((p) => p.is_default) || list[0]).id : cur));
      })
      .catch(() => {});
  }, []);

  // The URL mirrors the view at all times: refreshing (or opening a shared
  // link) restores exactly this playlist + filters. replaceState adds no
  // history entry per keystroke. While this page is not the current path
  // (a tab switch in progress) App.tsx owns the URL - it pushes the /search
  // entry with the remembered query; we only update memory here.
  useEffect(() => {
    const qs = viewToQuery(pid, query, f, page, rows, sortKey, sortDir);
    rememberSearchQuery(qs);
    if (window.location.pathname === '/search') {
      const next = '/search' + (qs ? '?' + qs : '');
      if (window.location.pathname + window.location.search !== next) {
        window.history.replaceState(null, '', next);
      }
    }
  }, [pid, query, f, page, rows, sortKey, sortDir]);

  const q = query.trim();
  const activeClassifiers = useMemo(
    () => classifiers.filter((c) => c.field_type),
    [classifiers],
  );
  // Per-playlist counts of CURRENT values, from the loaded tracks - so the
  // filter labels track the selected playlist (c.stats is global).
  const perCls = useMemo(() => {
    const m: Record<number, { current: number; trueCount: number }> = {};
    for (const c of activeClassifiers) {
      let cur = 0, tr = 0;
      for (const t of tracks) {
        const v = t.classifications?.[String(c.id)];
        if (v && !v.stale) { cur++; if (c.field_type === 'boolean' && v.value === true) tr++; }
      }
      m[c.id] = { current: cur, trueCount: tr };
    }
    return m;
  }, [tracks, activeClassifiers]);
  const filterActive = Boolean(q || f.artist || f.album || f.title || f.minYear || f.maxYear || f.minDur || f.maxDur || f.language || Object.values(f.ai).some((v) => v !== undefined && v !== '' && v !== false));

  // Precompute the fuzzy haystack once per track load.
  const indexed = useMemo(() => tracks.map((t) => ({
    t,
    hay: [t.name, (t.artists || []).map((a) => a.name).join(' '), t.album_name].join(' ').toLowerCase(),
  })), [tracks]);

  const filtered = useMemo(() => {
    let out = indexed;
    if (q) out = out.filter(({ hay }) => fuzzyMatch(q, hay));
    if (f.artist.trim()) {
      const a = f.artist.trim().toLowerCase();
      out = out.filter(({ t }) => (t.artists || []).some((x) => x.name.toLowerCase().includes(a)));
    }
    if (f.album.trim()) {
      const a = f.album.trim().toLowerCase();
      out = out.filter(({ t }) => (t.album_name || '').toLowerCase().includes(a));
    }
    if (f.title.trim()) {
      const a = f.title.trim().toLowerCase();
      out = out.filter(({ t }) => (t.name || '').toLowerCase().includes(a));
    }
    if (f.minYear) out = out.filter(({ t }) => Number(yearOf(t)) >= Number(f.minYear));
    if (f.maxYear) out = out.filter(({ t }) => yearOf(t) && Number(yearOf(t)) <= Number(f.maxYear));
    if (f.minDur) out = out.filter(({ t }) => (t.duration_ms || 0) / 1000 >= Number(f.minDur));
    if (f.maxDur) out = out.filter(({ t }) => (t.duration_ms || 0) / 1000 <= Number(f.maxDur));
    if (f.language) out = out.filter(({ t }) => (t.language || '') === f.language);
    // AI-field filters: only tracks with a CURRENT value matching count.
    for (const c of activeClassifiers) {
      const want = f.ai[c.id];
      const empty = want === undefined || want === '' || want === false ||
        (typeof want === 'object' && !want?.min && !want?.max);
      if (empty) continue;
      out = out.filter(({ t }) => {
        const v = t.classifications?.[String(c.id)];
        if (!v || v.stale) return false;
        if (typeof want === 'object') {
          // number/datetime range
          const num = typeof v.value === 'number' ? v.value : Date.parse(v.value);
          if (num === undefined || Number.isNaN(num)) return false;
          if (want.min !== '' && num < Number(want.min)) return false;
          if (want.max !== '' && num > Number(want.max)) return false;
          return true;
        }
        if (typeof want === 'string') {
          return String(v.value).toLowerCase().includes(want.toLowerCase());
        }
        return v.value === want;
      });
    }
    return out;
  }, [indexed, q, f, activeClassifiers]);

  const sorted = useMemo(() => {
    const keyFn = (x: { t: Track }) =>
      sortKey === 'name' ? (x.t.name || '').toLowerCase()
        : sortKey === 'year' ? yearOf(x.t)
          : (x.t.duration_ms || 0);
    return [...filtered].sort((a, b) => {
      const av = keyFn(a), bv = keyFn(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
    });
  }, [filtered, sortKey, sortDir]);

  const clearAll = () => { setQuery(''); setF(baseFilters(EMPTY_AI)); setPage(0); };
  const paged = sorted.slice(page * rows, page * rows + rows);
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));
  const setAi = (cid: number, v: any) =>
    setF((prev) => ({ ...prev, ai: { ...prev.ai, [cid]: v } }));
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
    setPage(0);
  };

  const current = playlists.find((p) => p.id === pid);

  // Serialize the current filter state as the generated playlist's search spec
  // (same semantics the page applies client-side; the server resolves it the
  // same way at sync time).
  const buildSpec = () => {
    const ai: Record<string, any> = {};
    for (const [cid, v] of Object.entries(f.ai)) {
      if (v === undefined || v === '' || v === false) continue;
      if (typeof v === 'object' && !v?.min && !v?.max) continue;
      ai[cid] = v;
    }
    return {
      q,
      artist: f.artist, album: f.album, title: f.title,
      min_year: f.minYear ? Number(f.minYear) : null,
      max_year: f.maxYear ? Number(f.maxYear) : null,
      min_dur_s: f.minDur ? Number(f.minDur) : null,
      max_dur_s: f.maxDur ? Number(f.maxDur) : null,
      language: f.language,
      classifier_filters: ai,
    };
  };

  const doSave = async () => {
    if (!pid) return;
    setSaveBusy(true); setSaveError('');
    try {
      const r: any = await api.generatedCreate({
        name: saveName.trim() || 'Saved search',
        description: saveDesc.trim(),
        source_playlist_id: Number(pid),
        search_spec: buildSpec(),
        preview_mode: savePreview,
        sync_mode: saveMode,
      });
      setSaveOpen(false);
      setSavedNotice('Saved — "' + (saveName.trim() || 'Saved search') + '" now matches ' + (r.track_count ?? '?') + ' track(s). Manage it on the Generate tab.');
    } catch (e: any) { setSaveError(e?.message || String(e)); }
    finally { setSaveBusy(false); }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.75, flexWrap: 'wrap' }}>
        <SearchIcon color="primary" />
        <Typography variant="h5">Search</Typography>
        <TextField
          select size="small" label="Playlist" value={pid}
          onChange={(e) => { setPid(Number(e.target.value)); setPage(0); setQuery(''); setF(baseFilters(EMPTY_AI)); }}
          sx={{ minWidth: 280 }}
          InputProps={{ 'aria-label': 'playlist' }}
        >
          {playlists.map((p) => (
            <MenuItem key={p.id} value={p.id}>{p.name} ({(p.track_count || 0).toLocaleString()}){p.is_default ? ' · default' : ''}</MenuItem>
          ))}
        </TextField>
        <Chip size="small" variant="outlined" sx={{ opacity: 0.9 }}
          label={loading ? 'loading…' : sorted.length.toLocaleString() + ' of ' + tracks.length.toLocaleString() + ' tracks'} />
        {loading ? <CircularProgress size={16} /> : null}
        <Box sx={{ flexGrow: 1 }} />
        {filterActive ? <Button size="small" startIcon={<CloseIcon />} onClick={clearAll}>Clear</Button> : null}
        <Button size="small" variant="outlined" startIcon={<SaveAltIcon />} onClick={() => setSaveOpen(true)} disabled={!pid}>
          Save as generated playlist
        </Button>
      </Box>

      <TextField
        fullWidth value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}
        placeholder={authed ? 'Search title, artist, album — fuzzy, instant' : 'Connect to Spotify to search'}
        disabled={!authed}
        sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2.5, minHeight: 48 } }}
        InputProps={{
          startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
          endAdornment: query ? (
            <InputAdornment position="end">
              <IconButton size="small" aria-label="clear search" onClick={() => setQuery('')}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        }}
      />

      <Card sx={{ p: 2, mt: 1.75 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <TextField size="small" label="Artist" value={f.artist} onChange={set('artist')} sx={{ width: 140 }}
          inputProps={{ 'aria-label': 'artist' }} />
        <TextField size="small" label="Album" value={f.album} onChange={set('album')} sx={{ width: 140 }}
          inputProps={{ 'aria-label': 'album' }} />
        <TextField size="small" label="Title" value={f.title} onChange={set('title')} sx={{ width: 140 }}
          inputProps={{ 'aria-label': 'title' }} />
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <TextField size="small" label="Year" type="number" value={f.minYear} onChange={set('minYear')}
            sx={{ width: 88 }} inputProps={{ 'aria-label': 'min year' }} />
          <Typography color="text.secondary">–</Typography>
          <TextField size="small" label="Year" type="number" value={f.maxYear} onChange={set('maxYear')}
            sx={{ width: 88 }} inputProps={{ 'aria-label': 'max year' }} />
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <TextField size="small" label="Dur (s)" type="number" value={f.minDur} onChange={set('minDur')}
            sx={{ width: 88 }} inputProps={{ 'aria-label': 'min duration' }} />
          <Typography color="text.secondary">–</Typography>
          <TextField size="small" label="Dur (s)" type="number" value={f.maxDur} onChange={set('maxDur')}
            sx={{ width: 88 }} inputProps={{ 'aria-label': 'max duration' }} />
        </Box>
        <TextField size="small" select label="Language" value={f.language} onChange={set('language')} sx={{ width: 110 }}>
          <MenuItem value="">Any</MenuItem>
          <MenuItem value="es">Spanish</MenuItem>
        </TextField>
      </Box>

      {activeClassifiers.length > 0 ? (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 1.75, pt: 1.5, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SmartToyIcon fontSize="small" color="primary" />
            <Typography variant="caption" color="text.secondary">AI fields</Typography>
          </Box>
          {activeClassifiers.map((c) => {
            const want = f.ai[c.id];
            const counts = perCls[c.id] || { current: 0, trueCount: 0 };
            if (c.field_type === 'boolean') {
              return (
                <FormControlLabel
                  key={c.id}
                  control={<Checkbox size="small" checked={want === true} onChange={(e) => setAi(c.id, e.target.checked)} />}
                  label={
                    <Tooltip title={c.query}>
                      <Typography variant="body2">{c.name} <Typography component="span" variant="caption" color="text.secondary">({counts.trueCount.toLocaleString()} true here)</Typography></Typography>
                    </Tooltip>
                  }
                />
              );
            }
            if (c.field_type === 'string') {
              return (
                <TextField key={c.id} size="small" label={c.name} value={want ?? ''}
                  onChange={(e) => setAi(c.id, e.target.value)} sx={{ width: 140 }} />
              );
            }
            if (c.field_type === 'number') {
              return (
                <Box key={c.id} sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                  <Typography variant="caption">{c.name}:</Typography>
                  <TextField size="small" type="number" value={typeof want === 'object' ? (want?.min ?? '') : (want ?? '')}
                    onChange={(e) => setAi(c.id, { min: e.target.value, max: (typeof want === 'object' && want?.max) || '' })} sx={{ width: 90 }} />
                  <Typography color="text.secondary">–</Typography>
                  <TextField size="small" type="number" value={typeof want === 'object' ? (want?.max ?? '') : ''}
                    onChange={(e) => setAi(c.id, { max: e.target.value, min: (typeof want === 'object' && want?.min) || '' })} sx={{ width: 90 }} />
                </Box>
              );
            }
            // datetime (range)
            return (
              <Box key={c.id} sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                <Typography variant="caption">{c.name}:</Typography>
                <TextField size="small" type="date" value={typeof want === 'object' ? (want?.min ?? '') : (want ?? '')}
                  onChange={(e) => setAi(c.id, { min: e.target.value, max: (typeof want === 'object' && want?.max) || '' })} sx={{ width: 140 }} InputLabelProps={{ shrink: true }} />
                <Typography color="text.secondary">–</Typography>
                <TextField size="small" type="date" value={typeof want === 'object' ? (want?.max ?? '') : ''}
                  onChange={(e) => setAi(c.id, { max: e.target.value, min: (typeof want === 'object' && want?.min) || '' })} sx={{ width: 140 }} InputLabelProps={{ shrink: true }} />
              </Box>
            );
          })}
        </Box>
      ) : null}
      </Card>

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }} action={<Button color="inherit" size="small" onClick={clearAll}>Dismiss</Button>}>
          {error}
        </Alert>
      ) : null}

      <DataTable sx={{ mt: 2 }}>
        {loading && tracks.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>
        ) : sorted.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <FilterAltOffIcon color="disabled" sx={{ mb: 1 }} />
            <Typography color="text.secondary">
              No tracks match{q ? <> “{q}”</> : ' your filters'}.
            </Typography>
            <Button size="small" sx={{ mt: 1 }} onClick={clearAll}>Clear filters</Button>
          </Box>
        ) : (
          <>
            <TableContainer sx={{ maxHeight: 'calc(100vh - 340px)' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 36 }} />
                    <TableCell sortDirection={sortKey === 'name' ? sortDir : false}>
                      <TableSortLabel active={sortKey === 'name'} direction={sortDir} onClick={() => toggleSort('name')}>Title</TableSortLabel>
                    </TableCell>
                    <TableCell>Artists</TableCell>
                    <TableCell>Album</TableCell>
                    <TableCell sortDirection={sortKey === 'year' ? sortDir : false}>
                      <TableSortLabel active={sortKey === 'year'} direction={sortDir} onClick={() => toggleSort('year')}>Year</TableSortLabel>
                    </TableCell>
                    <TableCell>Lang</TableCell>
                    {activeClassifiers.map((c) => (
                      <TableCell key={c.id} align="center">
                        <Tooltip title={c.query}><Typography variant="caption">{c.name} (AI)</Typography></Tooltip>
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {paged.map(({ t }) => (
                    <TableRow key={t.id} hover>
                      <TableCell>
                        <Tooltip title="Open in Spotify">
                          <IconButton size="small" component="a"
                            href={t.external_url || `https://open.spotify.com/track/${t.spotify_track_id}`}
                            target="_blank" rel="noreferrer" aria-label="open in spotify">
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 500 }}>{t.name}</TableCell>
                      <TableCell>{(t.artists || []).map((a) => a.name).join(', ')}</TableCell>
                      <TableCell sx={{ maxWidth: 220 }}><Typography noWrap variant="body2">{t.album_name}</Typography></TableCell>
                      <TableCell>{yearOf(t) || '—'}</TableCell>
                      <TableCell>{t.language || '—'}</TableCell>
                      {activeClassifiers.map((c) => {
                        const v = t.classifications?.[String(c.id)];
                        const open = () => openReason(t, c);
                        return (
                          <TableCell key={c.id} align="center">
                            {!v ? (
                              <Tooltip title="Not classified yet"><Chip size="small" label="·" variant="outlined" sx={{ height: 18, minWidth: 18, '& .MuiChip-label': { px: 0.25, fontSize: '0.7rem' } }} /></Tooltip>
                            ) : v.stale ? (
                              <Tooltip title={`Stale (classifier changed): ${JSON.stringify(v.value)} — click for reasoning`}>
                                <Box onClick={open} sx={{ cursor: 'pointer', display: 'inline-block' }}>
                                  <Chip size="small" color="warning" label="~" sx={{ height: 18, minWidth: 18, '& .MuiChip-label': { px: 0.25 } }} />
                                </Box>
                              </Tooltip>
                            ) : c.field_type === 'boolean' && v.value === true ? (
                              <Tooltip title={v.reason ? `${v.reason} — click for reasoning` : 'classified true — click for reasoning'}>
                                <Box onClick={open} sx={{ cursor: 'pointer', display: 'inline-block' }}>
                                  <CheckCircleIcon fontSize="small" color="success" />
                                </Box>
                              </Tooltip>
                            ) : (
                              <Tooltip title={`classified: ${JSON.stringify(v.value)}${v.reason ? ' — ' + v.reason : ''} — click for reasoning`}>
                                <Box onClick={open} sx={{ cursor: 'pointer', display: 'inline-block' }}>
                                  <Typography variant="caption" color="text.disabled">{c.field_type === 'boolean' ? '–' : JSON.stringify(v.value)}</Typography>
                                </Box>
                              </Tooltip>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <TablePagination
              component="div" count={sorted.length} page={page} onPageChange={(_, p) => setPage(p)}
              rowsPerPage={rows} onRowsPerPageChange={(e) => { setRows(Number(e.target.value)); setPage(0); }}
            />
          </>
        )}
      </DataTable>

      <Dialog open={!!reasonFor} onClose={() => setReasonFor(null)} maxWidth="sm" fullWidth>
        {reasonFor && (() => {
          const rv = reasonFor.t.classifications?.[String(reasonFor.c.id)];
          const valueStr = rv ? JSON.stringify(rv.value) : '—';
          return (
            <>
              <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <SmartToyIcon fontSize="small" />
                <span>{reasonFor.c.name} — reasoning</span>
              </DialogTitle>
              <DialogContent>
                <Typography variant="subtitle2" sx={{ mb: 0.25 }}>{reasonFor.t.name}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                  {(reasonFor.t.artists || []).map((a) => a.name).join(', ')}
                  {reasonFor.t.album_name ? ' · ' + reasonFor.t.album_name : ''}
                  {yearOf(reasonFor.t) ? ' · ' + yearOf(reasonFor.t) : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                  Question: {reasonFor.c.query}
                </Typography>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <Typography variant="caption" color="text.secondary">Assigned value:</Typography>
                  <Chip size="small" label={valueStr} variant="outlined" />
                </Box>

                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Recorded at classification</Typography>
                {rv?.reason ? (
                  <Typography variant="body2">{rv.reason}</Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary"><em>No reason was recorded for this track.</em></Typography>
                )}

                <Divider sx={{ my: 2 }} />

                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                  <Typography variant="subtitle2">Detailed explanation <Typography component="span" variant="caption" color="text.secondary">(live LLM)</Typography></Typography>
                  <Button size="small" variant="outlined"
                    startIcon={explaining ? <CircularProgress size={14} /> : <SmartToyIcon />}
                    onClick={fetchExplanation} disabled={explaining}>
                    {explanation ? 'Explain again' : 'Explain in detail'}
                  </Button>
                </Box>
                {explaining ? (
                  <Typography variant="body2" color="text.secondary">Asking the model…</Typography>
                ) : explainError ? (
                  <Alert severity="error" sx={{ mb: 0.5 }}>{explainError}</Alert>
                ) : explanation ? (
                  <Typography variant="body2">{explanation}</Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Get a fresh, detailed explanation from the model of why this track received its value.
                  </Typography>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setReasonFor(null)}>Close</Button>
              </DialogActions>
            </>
          );
        })()}
      </Dialog>

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Save as generated playlist</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Saves this exact search (fuzzy text, metadata and AI filters) on
              "{current ? current.name : 'the playlist'}" as a generated playlist
              you can sync to Spotify — manage it on the Generate tab.
            </Typography>
            <TextField size="small" label="Name" value={saveName} onChange={(e) => setSaveName(e.target.value)}
              inputProps={{ 'aria-label': 'generated name' }} />
            <TextField size="small" label="Description (optional)" value={saveDesc} onChange={(e) => setSaveDesc(e.target.value)}
              inputProps={{ 'aria-label': 'generated description' }} />
            <FormControlLabel
              control={<Checkbox size="small" checked={savePreview} onChange={(e) => setSavePreview(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  Preview mode — show what <b>would</b> sync as a diff; write nothing to Spotify
                </Typography>
              }
            />
            <TextField size="small" select label="Sync" value={saveMode} onChange={(e) => setSaveMode(e.target.value)} sx={{ width: 340 }}>
              <MenuItem value="once">Manual only (I sync when I want)</MenuItem>
              <MenuItem value="ongoing">Ongoing (auto re-sync about every 30 min)</MenuItem>
            </TextField>
            {saveError ? <Alert severity="error">{saveError}</Alert> : null}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={doSave} disabled={saveBusy}>
            {saveBusy ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {savedNotice ? <Alert severity="success" sx={{ mt: 2 }} onClose={() => setSavedNotice('')}>{savedNotice}</Alert> : null}
    </Box>
  );
}
