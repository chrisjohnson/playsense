import { useState, useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
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
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';

import { api, PlaylistItem, Track, SearchResponse } from '../api';

interface Props { authed: boolean; }

type SortKey = 'name' | 'year';

const LANG_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'es', label: 'Spanish' },
];

interface Filters {
  title: string;
  artist: string;
  album: string;
  minYear: string;
  maxYear: string;
  language: string;
}

const EMPTY_FILTERS: Filters = { title: '', artist: '', album: '', minYear: '', maxYear: '', language: '' };

export default function Search({ authed }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [pid, setPid] = useState<number | ''>('');
  const [query, setQuery] = useState('');
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const reqRef = useRef(0);

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
  const filterActive = Boolean(f.title || f.artist || f.album || f.minYear || f.maxYear || f.language);

  // One debounced server call drives everything: metadata filters are plain
  // SQL (fast locally); a non-empty query additionally goes through the LLM.
  useEffect(() => {
    setPage(0);
    if (!pid) { setRes(null); return; }
    const key = ++reqRef.current;
    setSearching(true); setError('');
    const h = setTimeout(async () => {
      try {
        const body: any = {
          playlist_id: Number(pid),
          q: q || null,
          title: f.title.trim() || null,
          artist: f.artist.trim() || null,
          album: f.album.trim() || null,
          min_year: f.minYear ? Number(f.minYear) : null,
          max_year: f.maxYear ? Number(f.maxYear) : null,
          language: f.language || null,
          use_semantic: true,
          limit: 500,
        };
        const r = await api.search(body);
        if (key === reqRef.current) setRes(r as SearchResponse);
      } catch (e: any) {
        if (key === reqRef.current) { setError(e?.message || String(e)); setRes(null); }
      } finally {
        if (key === reqRef.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [q, f, pid]);

  const tracks: Track[] = res?.tracks ?? [];
  const sorted = useMemo(() => {
    const keyFn = (t: Track) =>
      sortKey === 'name' ? (t.name || '').toLowerCase() : (t.release_date || '').slice(0, 4);
    return [...tracks].sort((a, b) => {
      const av = keyFn(a), bv = keyFn(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
    });
  }, [tracks, sortKey, sortDir]);

  const clearAll = () => { setQuery(''); setF(EMPTY_FILTERS); };
  const paged = sorted.slice(page * rows, page * rows + rows);
  const showReason = Boolean(q) && res?.semantic === 'llm';

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
    setPage(0);
  };

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Tracks</Typography>
        {searching ? <CircularProgress size={18} /> : null}
        {q && res ? (
          res.semantic === 'llm' ? (
            <Chip size="small" color="success" label="Semantic · LLM" />
          ) : (
            <Chip size="small" color="warning" label="Keyword match (LLM unavailable)" />
          )
        ) : null}
        <TextField
          select size="small" label="Playlist" value={pid}
          onChange={(e) => setPid(Number(e.target.value))}
          sx={{ minWidth: 260 }}
          InputProps={{ 'aria-label': 'playlist' }}
        >
          {playlists.map((p) => (
            <MenuItem key={p.id} value={p.id}>{p.name} ({p.track_count})</MenuItem>
          ))}
        </TextField>
      </Box>

      <TextField
        fullWidth value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={authed ? 'Ask the LLM — try “mariachi music” or “sad love songs”' : 'Connect to Spotify to search'}
        disabled={!authed}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
          ),
          endAdornment: query ? (
            <InputAdornment position="end">
              <IconButton size="small" aria-label="clear search" onClick={() => setQuery('')}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Free text is interpreted by the LLM together with each track's metadata — moods, styles, scenes, eras.
        The filters below are instant.
      </Typography>

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <TextField size="small" label="Artist" value={f.artist} onChange={set('artist')} sx={{ width: 140 }}
          inputProps={{ 'aria-label': 'artist' }} />
        <TextField size="small" label="Album" value={f.album} onChange={set('album')} sx={{ width: 140 }}
          inputProps={{ 'aria-label': 'album' }} />
        <TextField size="small" label="Title" value={f.title} onChange={set('title')} sx={{ width: 140 }}
          inputProps={{ 'aria-label': 'title' }} />
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <TextField size="small" label="Year" type="number" value={f.minYear} onChange={set('minYear')}
            sx={{ width: 90 }} inputProps={{ 'aria-label': 'min year' }} />
          <Typography color="text.secondary">–</Typography>
          <TextField size="small" label="Year" type="number" value={f.maxYear} onChange={set('maxYear')}
            sx={{ width: 90 }} inputProps={{ 'aria-label': 'max year' }} />
        </Box>
        <TextField size="small" select label="Language" value={f.language} onChange={set('language')} sx={{ width: 120 }}>
          {LANG_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
        </TextField>
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto', pb: 1 }}>
          {res ? `${res.count.toLocaleString()} of ${res.total.toLocaleString()} tracks` : '…'}
        </Typography>
        {(q || filterActive) ? (
          <Button size="small" onClick={clearAll} sx={{ pb: '9px' }}>Clear</Button>
        ) : null}
      </Box>

      {error ? (
        <Alert
          severity="error" sx={{ mt: 2 }}
          action={<Button color="inherit" size="small" onClick={clearAll}>Dismiss</Button>}
        >
          Search failed: {error}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ mt: 2 }}>
        {searching && !res ? (
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
                      <TableSortLabel active={sortKey === 'name'} direction={sortDir} onClick={() => toggleSort('name')}>
                        Title
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>Artists</TableCell>
                    <TableCell>Album</TableCell>
                    <TableCell sortDirection={sortKey === 'year' ? sortDir : false}>
                      <TableSortLabel active={sortKey === 'year'} direction={sortDir} onClick={() => toggleSort('year')}>
                        Year
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>Lang</TableCell>
                    {showReason ? <TableCell>Match</TableCell> : null}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {paged.map((t) => (
                    <TableRow key={t.id} hover>
                      <TableCell>
                        <Tooltip title="Open in Spotify">
                          <IconButton
                            size="small" component="a"
                            href={t.external_url || `https://open.spotify.com/track/${t.spotify_track_id}`}
                            target="_blank" rel="noreferrer" aria-label="open in spotify"
                          >
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 500 }}>{t.name}</TableCell>
                      <TableCell>{(t.artists || []).map((a) => a.name).join(', ')}</TableCell>
                      <TableCell sx={{ maxWidth: 220 }}>
                        <Typography noWrap variant="body2">{t.album_name}</Typography>
                      </TableCell>
                      <TableCell>{(t.release_date || '').slice(0, 4) || '—'}</TableCell>
                      <TableCell>{t.language || '—'}</TableCell>
                      {showReason ? (
                        <TableCell sx={{ maxWidth: 180 }}>
                          <Tooltip title={t.match_reason || ''}>
                            <Typography noWrap variant="caption" color="text.secondary">
                              {t.match_reason || '—'}
                            </Typography>
                          </Tooltip>
                        </TableCell>
                      ) : null}
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
