import { useState, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
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
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import { api, PlaylistItem, Track, Classifier } from '../api';

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

export default function Search({ authed }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [pid, setPid] = useState<number | ''>('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [f, setF] = useState<Filters>(baseFilters(EMPTY_AI));
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

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
        setPid((cur) => (cur === '' && list.length ? list[0].id : cur));
      })
      .catch(() => {});
  }, []);

  const q = query.trim();
  const activeClassifiers = useMemo(
    () => classifiers.filter((c) => c.field_type),
    [classifiers],
  );
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

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Tracks {current ? `— ${current.name}` : ''}
        </Typography>
        {loading ? <CircularProgress size={18} /> : null}
        <Typography variant="body2" color="text.secondary" sx={{ pb: '9px' }}>
          {loading ? 'loading…' : `${sorted.length.toLocaleString()} of ${tracks.length.toLocaleString()} tracks`}
        </Typography>
        {filterActive ? <Button size="small" onClick={clearAll} sx={{ pb: '9px' }}>Clear</Button> : null}
        <TextField
          select size="small" label="Playlist" value={pid}
          onChange={(e) => { setPid(Number(e.target.value)); setPage(0); setQuery(''); setF(baseFilters(EMPTY_AI)); }}
          sx={{ minWidth: 240 }}
          InputProps={{ 'aria-label': 'playlist' }}
        >
          {playlists.map((p) => (
            <MenuItem key={p.id} value={p.id}>{p.name} ({p.track_count})</MenuItem>
          ))}
        </TextField>
      </Box>

      <TextField
        fullWidth value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}
        placeholder={authed ? 'Search title, artist, album — fuzzy, instant' : 'Connect to Spotify to search'}
        disabled={!authed}
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

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end', flexWrap: 'wrap', mt: 1 }}>
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
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 1, px: 1.5, py: 0.75 }}
          component={Paper} variant="outlined">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SmartToyIcon fontSize="small" color="primary" />
            <Typography variant="caption" color="text.secondary">AI fields</Typography>
          </Box>
          {activeClassifiers.map((c) => {
            const want = f.ai[c.id];
            const stats = c.stats || { current: 0 };
            if (c.field_type === 'boolean') {
              return (
                <FormControlLabel
                  key={c.id}
                  control={<Checkbox size="small" checked={want === true} onChange={(e) => setAi(c.id, e.target.checked)} />}
                  label={
                    <Tooltip title={c.query}>
                      <Typography variant="body2">{c.name} <Typography component="span" variant="caption" color="text.secondary">({stats.current ?? 0} true)</Typography></Typography>
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

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }} action={<Button color="inherit" size="small" onClick={clearAll}>Dismiss</Button>}>
          {error}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ mt: 2 }}>
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
            <TableContainer>
              <Table size="small">
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
                        return (
                          <TableCell key={c.id} align="center">
                            {!v ? (
                              <Tooltip title="Not classified yet"><Chip size="small" label="·" variant="outlined" sx={{ height: 18, minWidth: 18, '& .MuiChip-label': { px: 0.25, fontSize: '0.7rem' } }} /></Tooltip>
                            ) : v.stale ? (
                              <Tooltip title={`Stale (classifier changed): ${JSON.stringify(v.value)}`}><Chip size="small" color="warning" label="~" sx={{ height: 18, minWidth: 18, '& .MuiChip-label': { px: 0.25 } }} /></Tooltip>
                            ) : c.field_type === 'boolean' && v.value === true ? (
                              <Tooltip title={v.reason || 'classified true'}><CheckCircleIcon fontSize="small" color="success" /></Tooltip>
                            ) : (
                              <Tooltip title={`classified: ${JSON.stringify(v.value)}${v.reason ? ' — ' + v.reason : ''}`}>
                                <Typography variant="caption" color="text.disabled">{c.field_type === 'boolean' ? '–' : JSON.stringify(v.value)}</Typography>
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
      </Paper>
    </Box>
  );
}
